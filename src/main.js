const { invoke } = window.__TAURI__.core;

// * DOM element references
const connectionStatus = document.querySelector("#connection-status");
const connectDefaultBtn = document.querySelector("#connect-default-btn");
const disconnectBtn = document.querySelector("#disconnect-btn");
const controllerStatus = document.querySelector("#controller-status");
const joystickValues = document.querySelector("#joystick-values");
const joystickContainer = document.querySelector("#joystick-container");
const joystickBase = document.querySelector("#joystick-base");
const joystickStick = document.querySelector("#joystick-stick");
const logContainer = document.querySelector("#log-container");
const logBall = document.querySelector("#log-ball");
const logModal = document.querySelector("#log-modal");
const closeLogBtn = document.querySelector("#close-log-btn");
const grabBtn = document.querySelector("#grab-btn");
const releaseBtn = document.querySelector("#release-btn");
const throwBtn = document.querySelector("#throw-btn");
const liftingSlider = document.querySelector("#lifting-slider");
const liftingValue = document.querySelector("#lifting-value");

// * Configuration constants
const DEFAULT_CONNECT_DEVICE_MAC = "98:88:E0:10:BC:3E";
const JOYSTICK_ZERO_VALUE = 0x7F; // * 127 as mid value (0)
const POLL_INTERVAL = 30; // ! Poll controller status every 30ms
const SEND_INTERVAL = 20; // ! Send joystick data every 20ms
const LIFTING_MIN = 0x00;
const LIFTING_MAX = 0xFF;

// * Application state
let isConnected = false;
let controllerUsable = false;
let pollIntervalId = null;
let sendIntervalId = null;
let liftingPendingValue = null;
let liftingSendTimeoutId = null;

// * Joystick state
let joystickActive = false;
let currentX = JOYSTICK_ZERO_VALUE;
let currentY = JOYSTICK_ZERO_VALUE;

// * Track active touches for multi-finger stability
let activeTouches = new Map();
let primaryTouchId = null;

const supportsTouchInput = "ontouchstart" in window || navigator.maxTouchPoints > 0;

function bindInstantButton(button, action) {
    if (!button) return;
    let lastTriggerTime = 0;
    const DEBOUNCE_MS = 120;

    const doAction = () => {
        const now = Date.now();
        if (now - lastTriggerTime < DEBOUNCE_MS) {
            return;
        }
        lastTriggerTime = now;
        action();
    };

    const triggerWithAnimation = () => {
        // Manually trigger active state for animation
        button.classList.add("btn-active");
        setTimeout(() => {
            button.classList.remove("btn-active");
        }, 100);
        doAction();
    };

    // Use touchstart for immediate response on touch devices
    button.addEventListener("touchstart", (e) => {
        e.stopPropagation();
        triggerWithAnimation();
    }, { passive: true });

    // Use click for mouse and as fallback
    button.addEventListener("click", () => {
        doAction();
    });
}

// ? Add log message to UI
function addLog(message, type = "info") {
    const entry = document.createElement("p");
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

// ? Update connection status and UI
function updateConnectionStatus(connected, address = null) {
    isConnected = connected;
    if (connected) {
        connectionStatus.textContent = `✓ 已连接: ${address}`;
        connectionStatus.style.color = "#28a745";
        disconnectBtn.disabled = false;
        connectDefaultBtn.disabled = true;
        setLiftingSliderEnabled(controllerUsable);
        
        // Start polling controller status
        startPolling();
    } else {
        connectionStatus.textContent = "✗ 未连接";
        connectionStatus.style.color = "#dc3545";
        disconnectBtn.disabled = true;
        connectDefaultBtn.disabled = false;
        setLiftingSliderEnabled(false);
        
        // Stop polling
        stopPolling();
        updateControllerStatus(false);
    }
}

// ? Update controller usable status
function updateControllerStatus(usable) {
    controllerUsable = usable;
    if (usable) {
        controllerStatus.textContent = "● 可操控";
        controllerStatus.style.color = "#28a745";
        joystickContainer.classList.remove("joystick-disabled");
        setLiftingSliderEnabled(true);
        
        // Start sending joystick data
        if (!sendIntervalId) {
            sendIntervalId = setInterval(sendJoystickData, SEND_INTERVAL);
        }
    } else {
        controllerStatus.textContent = "● 不可操控";
        controllerStatus.style.color = "#dc3545";
        joystickContainer.classList.add("joystick-disabled");
        setLiftingSliderEnabled(false);
        
        // Stop sending joystick data
        if (sendIntervalId) {
            clearInterval(sendIntervalId);
            sendIntervalId = null;
        }
        
        // Reset joystick to center
        resetJoystick();
    }
}

// ? Update joystick value display
function updateJoystickDisplay(x, y) {
    joystickValues.innerHTML = `X: ${x} (0x${x.toString(16).toUpperCase().padStart(2, '0')})<br>Y: ${y} (0x${y.toString(16).toUpperCase().padStart(2, '0')})`;
}

function setLiftingSliderEnabled(enabled) {
    if (!liftingSlider) return;
    const active = enabled && isConnected;
    liftingSlider.classList.toggle("slider-disabled", !active);
}

function updateLiftingDisplay(value) {
    if (!liftingValue) return;
    liftingValue.textContent = `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

// ? Reset joystick to center position
function resetJoystick() {
    // Add transition for smooth return to center
    joystickStick.style.transition = "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)";
    joystickStick.style.left = "50%";
    joystickStick.style.top = "50%";
    currentX = JOYSTICK_ZERO_VALUE;
    currentY = JOYSTICK_ZERO_VALUE;
    updateJoystickDisplay(currentX, currentY);
    // Remove transition after animation completes
    setTimeout(() => {
        joystickStick.style.transition = "none";
    }, 200);
}

// ? Convert screen position to joystick value (0x00 - 0xFF)
function positionToValue(position, max) {
    // position: -1 to 1 (center is 0)
    // Convert to 0x00 (0) to 0xFF (255), with 0x7F (127) as center
    const value = Math.round((position + 1) * 127.5);
    return Math.max(0, Math.min(255, value));
}

// ? Handle joystick movement
function handleJoystickMove(clientX, clientY) {
    // Allow joystick movement at any time for debugging/testing
    // Ensure no transition during active movement
    if (joystickStick.style.transition !== "none") {
        joystickStick.style.transition = "none";
    }
    
    const rect = joystickBase.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    let deltaX = clientX - centerX;
    let deltaY = clientY - centerY;
    
    // Calculate max radius: stick is 22% of base width, so subtract 11% from each side
    const stickRadius = (rect.width / 2) * 0.11; // 22% / 2 = 11%
    const maxRadius = (rect.width / 2) - stickRadius;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    if (distance > maxRadius) {
        const angle = Math.atan2(deltaY, deltaX);
        deltaX = Math.cos(angle) * maxRadius;
        deltaY = Math.sin(angle) * maxRadius;
    }
    
    // Update stick position
    const percentX = 50 + (deltaX / maxRadius) * 50;
    const percentY = 50 + (deltaY / maxRadius) * 50;
    joystickStick.style.left = `${percentX}%`;
    joystickStick.style.top = `${percentY}%`;
    
    // Convert to joystick values
    // X: left (-1) = 0x00, center (0) = 0x7F, right (1) = 0xFF
    // Y: up (-1) = 0x00, center (0) = 0x7F, down (1) = 0xFF
    const normalizedX = deltaX / maxRadius;
    const normalizedY = deltaY / maxRadius;
    
    currentX = positionToValue(normalizedX, maxRadius);
    currentY = positionToValue(normalizedY, maxRadius);
    
    updateJoystickDisplay(currentX, currentY);
}

// ? Start joystick interaction
function startJoystick(event) {
    // Allow joystick movement at any time for debugging/testing
    joystickActive = true;
    joystickStick.classList.add("active");
    
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const clientY = event.touches ? event.touches[0].clientY : event.clientY;
    handleJoystickMove(clientX, clientY);
    
    if (event.preventDefault) {
        event.preventDefault();
    }
}

// ? Move joystick
function moveJoystick(event) {
    if (!joystickActive) return;
    
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const clientY = event.touches ? event.touches[0].clientY : event.clientY;
    handleJoystickMove(clientX, clientY);
    
    if (event.preventDefault) {
        event.preventDefault();
    }
}

// ? Stop joystick interaction
function stopJoystick() {
    if (!joystickActive) return;
    
    joystickActive = false;
    joystickStick.classList.remove("active");
    
    // Reset to center with animation
    resetJoystick();
}

// ? Check if touch target is in joystick area
function isTouchInJoystick(clientX, clientY) {
    const rect = joystickBase.getBoundingClientRect();
    return clientX >= rect.left &&
           clientX <= rect.right &&
           clientY >= rect.top &&
           clientY <= rect.bottom;
}

// ? Enhanced touch handling for multi-finger stability
function handleTouchStart(event) {
    // Only process touches that start on the joystick
    for (let i = 0; i < event.touches.length; i++) {
        const touch = event.touches[i];
        if (isTouchInJoystick(touch.clientX, touch.clientY)) {
            activeTouches.set(touch.identifier, {
                x: touch.clientX,
                y: touch.clientY
            });
        }
    }

    // Assign primary touch only if not already assigned
    if (primaryTouchId === null) {
        // Find first touch in joystick area
        for (let i = 0; i < event.touches.length; i++) {
            const touch = event.touches[i];
            if (isTouchInJoystick(touch.clientX, touch.clientY)) {
                primaryTouchId = touch.identifier;
                startJoystick({
                    touches: [touch]
                });
                break;
            }
        }
    }
}

// ? Handle touch move events
function handleTouchMove(event) {
    // Only prevent default if actually controlling joystick
    if (primaryTouchId !== null && joystickActive) {
        const primaryTouch = Array.from(event.touches).find(t => t.identifier === primaryTouchId);
        if (!primaryTouch) {
            return;
        }

        const joystickTouchX = primaryTouch.clientX;
        const joystickTouchY = primaryTouch.clientY;

        if (isTouchInJoystick(joystickTouchX, joystickTouchY)) {
            handleJoystickMove(joystickTouchX, joystickTouchY);
        }

        if (event.touches.length === 1 && event.cancelable) {
            event.preventDefault();
        }
    }
}

// ? Handle touch end events
function handleTouchEnd(event) {
    // Remove ended touches
    for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i];
        activeTouches.delete(touch.identifier);

        // If primary touch ended, stop joystick
        if (touch.identifier === primaryTouchId) {
            primaryTouchId = null;
            stopJoystick();

            // Check if other joystick-area touches remain
            if (event.touches.length > 0) {
                for (let j = 0; j < event.touches.length; j++) {
                    const remainingTouch = event.touches[j];
                    if (isTouchInJoystick(remainingTouch.clientX, remainingTouch.clientY)) {
                        primaryTouchId = remainingTouch.identifier;
                        startJoystick({
                            touches: [remainingTouch]
                        });
                        break;
                    }
                }
            }
        }
    }
}

// ? Handle touch cancel events
function handleTouchCancel(event) {
    activeTouches.clear();
    primaryTouchId = null;
    stopJoystick();
}

// * Toggle log modal visibility
function openLogModal() {
    logModal.classList.add("active");
}

// * Close log modal
function closeLogModal() {
    logModal.classList.remove("active");
}

// ? Send joystick data to backend
async function sendJoystickData() {
    if (!isConnected || !controllerUsable) return;
    
    try {
        await invoke("send_joystick_data", { x: currentX, y: currentY });
    } catch (error) {
        // Only log significant errors, not every send failure
        if (error.includes("not usable")) {
            addLog(`发送失败: ${error}`, "warning");
        }
    }
}

// ? Queue lifting arm value to send with throttling
function queueLiftingSend(value) {
    if (!isConnected || !controllerUsable) return;
    liftingPendingValue = value;
    if (liftingSendTimeoutId) {
        return;
    }
    liftingSendTimeoutId = setTimeout(async () => {
        liftingSendTimeoutId = null;
        if (liftingPendingValue === null) {
            return;
        }
        const valueToSend = liftingPendingValue;
        liftingPendingValue = null;
        await sendLiftingArmValue(valueToSend);
    }, 40);
}

// ? Send lifting arm value to backend
async function sendLiftingArmValue(value) {
    try {
        await invoke("send_lifting_arm_value", { value });
    } catch (error) {
        addLog(`滑杆发送失败: ${error}`, "error");
    }
}

// ? Poll controller status from device
async function pollControllerStatus() {
    if (!isConnected) return;
    
    try {
        const usable = await invoke("poll_controller_status");
        updateControllerStatus(usable);
    } catch (error) {
        // Silently handle errors during polling
        updateControllerStatus(false);
    }
}

// ? Start polling controller status
function startPolling() {
    if (pollIntervalId) return;
    
    pollIntervalId = setInterval(pollControllerStatus, POLL_INTERVAL);
    addLog("开始轮询控制器状态", "info");
}

// ? Stop polling controller status
function stopPolling() {
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
        addLog("停止轮询控制器状态", "info");
    }
    
    if (sendIntervalId) {
        clearInterval(sendIntervalId);
        sendIntervalId = null;
    }
}

// ? Check Bluetooth permissions
async function checkPermissions() {
    try {
        const hasPermissions = await invoke("check_ble_permissions");
        
        if (hasPermissions) {
            addLog("蓝牙权限已授予", "success");
        } else {
            addLog("蓝牙权限未授予，请在设置中授予权限", "warning");
        }
    } catch (error) {
        addLog(`权限检查错误: ${error}`, "error");
    }
}

// ? Auto scan and connect to default device
async function autoConnect() {
    try {
        addLog("正在扫描并连接设备...", "info");
        await invoke("preload_operation");
        addLog("连接成功", "success");
        
        updateConnectionStatus(true, DEFAULT_CONNECT_DEVICE_MAC);
    } catch (error) {
        addLog(`自动连接失败: ${error}`, "error");
        updateConnectionStatus(false);
    }
}

// ? Manually connect to specified device
async function connectToDevice(address) {
    try {
        addLog(`正在连接设备 ${address}...`, "info");
        await invoke("connect", { addr: address });
        addLog("连接成功", "success");
        
        updateConnectionStatus(true, address);
    } catch (error) {
        addLog(`连接失败: ${error}`, "error");
        updateConnectionStatus(false);
    }
}

// ? Disconnect Bluetooth connection
async function disconnect() {
    try {
        addLog("正在断开连接...", "info");
        await invoke("disconnect");
        addLog("已断开连接", "success");
        
        updateConnectionStatus(false);
    } catch (error) {
        addLog(`断开连接失败: ${error}`, "error");
        updateConnectionStatus(false);
    }
}

// ? Arm control commands
async function grabArm() {
    if (!isConnected) {
        addLog("设备未连接，无法执行抓取", "warning");
        return;
    }

    try {
        addLog("执行抓取命令...", "info");
        await invoke("send_arm_command", { command: "grab" });
        addLog("✓ 机械臂已抓取", "success");
    } catch (error) {
        addLog(`抓取失败: ${error}`, "error");
    }
}

// ? Arm release commands
async function releaseArm() {
    if (!isConnected) {
        addLog("设备未连接，无法执行放开", "warning");
        return;
    }

    try {
        addLog("执行放开命令...", "info");
        await invoke("send_arm_command", { command: "release" });
        addLog("✓ 机械臂已放开", "success");
    } catch (error) {
        addLog(`放开失败: ${error}`, "error");
    }
}

// ? Arm throw commands
async function throwArm() {
    if (!isConnected) {
        addLog("设备未连接，无法执行投掷", "warning");
        return;
    }

    try {
        addLog("执行投掷命令...", "info");
        await invoke("send_arm_command", { command: "throw" });
        addLog("✓ 机械臂已投掷", "success");
    } catch (error) {
        addLog(`投掷失败: ${error}`, "error");
    }
}

// ! Application initialization
window.addEventListener("DOMContentLoaded", async () => {
    addLog("虚拟摇杆应用已启动", "success");
    
    // Prevent default gestures and zooming
    document.addEventListener('gesturestart', (e) => e.preventDefault(), false);
    document.addEventListener('dblclick', (e) => e.preventDefault(), false);

    // Prevent pinch zoom
    document.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
        }
    }, { passive: false });

    // Bind connection buttons
    connectDefaultBtn.addEventListener("click", () => connectToDevice(DEFAULT_CONNECT_DEVICE_MAC));
    disconnectBtn.addEventListener("click", disconnect);
    
    // Bind arm control buttons with immediate touch response
    bindInstantButton(grabBtn, grabArm);
    bindInstantButton(releaseBtn, releaseArm);
    bindInstantButton(throwBtn, throwArm);
    if (liftingSlider) {
        const handleLiftingInput = (event) => {
            const value = Number(event.target.value);
            updateLiftingDisplay(value);
            queueLiftingSend(value);
        };
        liftingSlider.min = LIFTING_MIN;
        liftingSlider.max = LIFTING_MAX;
        liftingSlider.value = LIFTING_MIN;
        updateLiftingDisplay(LIFTING_MIN);
        setLiftingSliderEnabled(false);
        liftingSlider.addEventListener("input", handleLiftingInput);
        liftingSlider.addEventListener("change", handleLiftingInput);
    }

    // Bind log modal controls
    logBall.addEventListener("click", openLogModal);
    closeLogBtn.addEventListener("click", closeLogModal);
    logModal.addEventListener("click", (e) => {
        if (e.target === logModal) closeLogModal();
    });

    // Bind joystick events
    // Mouse events
    joystickBase.addEventListener("mousedown", startJoystick);
    window.addEventListener("mousemove", moveJoystick);
    window.addEventListener("mouseup", stopJoystick);
    
    // Enhanced touch events for multi-finger stability
    joystickBase.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleTouchCancel, { passive: true });
    
    // Check permissions and auto connect
    await checkPermissions();
    await autoConnect();
});
