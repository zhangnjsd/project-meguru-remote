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
const throwBtn = document.querySelector("#throw-btn");
const startBtn = document.querySelector("#start-btn");
const liftingSliderClaw = document.querySelector("#lifting-slider-claw");
const liftingSliderA = document.querySelector("#lifting-slider-a");
const liftingSliderB = document.querySelector("#lifting-slider-b");
const liftingSliderC = document.querySelector("#lifting-slider-c");
const liftingSliderEnd = document.querySelector("#lifting-slider-end");
const liftingValue = document.querySelector("#lifting-value");
const rotationSlider = document.querySelector("#rotation-slider");
const deviceSelect = document.querySelector("#device-select");
const customMacInput = document.querySelector("#custom-mac-input");

// * Configuration constants
let KNOWN_DEVICES = [
    { name: "Haruka", address: "3C:0F:02:D1:D4:D2" },
    { name: "Meguri", address: "3C:0F:02:D1:E2:56" },
];

const JOYSTICK_ZERO_VALUE = 0x7F; // * 127 as mid value (0)
const POLL_INTERVAL = 1000; // ! Poll controller status every 1s
const LIFTING_MIN = 0x00;
const LIFTING_MAX = 0xFF;

// * Application state
let isConnected = false;
let controllerUsable = false;
let pollIntervalId = null;
let liftingPendingValues = { Claw: null, A: null, B: null, C: null };
let liftingSendTimeoutIds = { Claw: null, A: null, B: null, C: null };

// * Joystick state
let joystickActive = false;
let currentX = JOYSTICK_ZERO_VALUE;
let currentY = JOYSTICK_ZERO_VALUE;
let currentR = JOYSTICK_ZERO_VALUE;
let lastSentX = JOYSTICK_ZERO_VALUE;
let lastSentY = JOYSTICK_ZERO_VALUE;
let lastSentR = JOYSTICK_ZERO_VALUE;
let isJoystickSending = false;
let joystickSendIntervalId = null;
const JOYSTICK_SEND_INTERVAL = 30; // 30ms (approx 33Hz)
let zeroResendCount = 0; // Resend counter

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
        setRotationSliderEnabled(controllerUsable);
        
        // Start polling controller status
        startPolling();
        // Start joystick data loop
        startJoystickDataLoop();
    } else {
        connectionStatus.textContent = "✗ 未连接";
        connectionStatus.style.color = "#dc3545";
        disconnectBtn.disabled = true;
        connectDefaultBtn.disabled = false;
        setLiftingSliderEnabled(false);
        setRotationSliderEnabled(false);
        
        // Stop polling
        stopPolling();
        // Stop joystick data loop
        stopJoystickDataLoop();
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
        setRotationSliderEnabled(true);
    } else {
        controllerStatus.textContent = "● 不可操控";
        controllerStatus.style.color = "#dc3545";
        joystickContainer.classList.add("joystick-disabled");
        setLiftingSliderEnabled(false);
        setRotationSliderEnabled(false);
        
        // Reset joystick to center
        resetJoystick();
        // Reset rotation slider to center
        resetRotationSlider();
    }
}

// ? Reset rotation slider to center position
function resetRotationSlider() {
    if (!rotationSlider) return;
    rotationSlider.value = JOYSTICK_ZERO_VALUE;
    updateRotationDisplay(JOYSTICK_ZERO_VALUE);
    currentR = JOYSTICK_ZERO_VALUE;
}

// ? Update joystick value display
function updateJoystickDisplay(x, y) {
    joystickValues.innerHTML = `X: ${x} (0x${x.toString(16).toUpperCase().padStart(2, '0')})<br>Y: ${y} (0x${y.toString(16).toUpperCase().padStart(2, '0')})`;
}

function setLiftingSliderEnabled(enabled) {
    const active = enabled && isConnected;
    if (liftingSliderClaw) liftingSliderClaw.classList.toggle("slider-disabled", !active);
    if (liftingSliderA) liftingSliderA.classList.toggle("slider-disabled", !active);
    if (liftingSliderB) liftingSliderB.classList.toggle("slider-disabled", !active);
    if (liftingSliderC) liftingSliderC.classList.toggle("slider-disabled", !active);
    if (liftingSliderEnd) liftingSliderEnd.classList.toggle("slider-disabled", !active);
}

function setRotationSliderEnabled(enabled) {
    if (!rotationSlider) return;
    const active = enabled && isConnected;
    rotationSlider.classList.toggle("slider-disabled", !active);
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
    
    // Resend counter for zero position
    zeroResendCount = 5;
    
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
    joystickStick.style.transition = "none";
    
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
    
    const newX = positionToValue(normalizedX, maxRadius);
    const newY = positionToValue(normalizedY, maxRadius);
    
    // 只在数据变化时发送
    if (newX !== currentX || newY !== currentY) {
        currentX = newX;
        currentY = newY;
        updateJoystickDisplay(currentX, currentY);
        // 不再直接发送，由定时器统一发送
        // sendJoystickDataIfChanged();
    }
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
    
    const clientX = event.clientX;
    const clientY = event.clientY;
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

        handleJoystickMove(primaryTouch.clientX, primaryTouch.clientY);

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

// ? Send joystick data to backend only when changed
async function sendJoystickDataIfChanged() {
    if (!isConnected || !controllerUsable) return;
    
    const isZero = currentX === JOYSTICK_ZERO_VALUE && currentY === JOYSTICK_ZERO_VALUE && currentR === JOYSTICK_ZERO_VALUE;
    const hasChanged = currentX !== lastSentX || currentY !== lastSentY || currentR !== lastSentR;

    if (!hasChanged && (!isZero || zeroResendCount <= 0)) return;

    if (isJoystickSending) return;

    isJoystickSending = true;
    
    try {
        await invoke("send_joystick_data", { x: currentX, y: currentY, r: currentR });
        lastSentX = currentX;
        lastSentY = currentY;
        lastSentR = currentR;
        
        if (isZero && zeroResendCount > 0) {
            // ! Safely control resend count to avoid overflow
            zeroResendCount--;
        }
    } finally {
        isJoystickSending = false;
    }
}

// ? Start joystick data loop
function startJoystickDataLoop() {
    if (joystickSendIntervalId) return;
    joystickSendIntervalId = setInterval(sendJoystickDataIfChanged, JOYSTICK_SEND_INTERVAL);
}

// ? Stop joystick data loop
function stopJoystickDataLoop() {
    if (joystickSendIntervalId) {
        clearInterval(joystickSendIntervalId);
        joystickSendIntervalId = null;
    }
}

// ? Queue lifting arm value to send with throttling
function queueLiftingSend(channel, value) {
    if (!isConnected || !controllerUsable) return;
    liftingPendingValues[channel] = value;
    if (liftingSendTimeoutIds[channel]) {
        return;
    }
    liftingSendTimeoutIds[channel] = setTimeout(async () => {
        liftingSendTimeoutIds[channel] = null;
        if (liftingPendingValues[channel] === null) {
            return;
        }
        const valueToSend = liftingPendingValues[channel];
        liftingPendingValues[channel] = null;
        await sendLiftingArmValue(channel, valueToSend);
    }, 40);
}

// ? Send lifting arm value to backend
async function sendLiftingArmValue(channel, value) {
    try {
        await invoke("send_lifting_arm_value", { channel, value });
    } catch (error) {
        addLog(`滑杆 ${channel} 发送失败: ${error}`, "error");
    }
}

// ? Queue rotation value to send with throttling
function queueRotationSend(value) {
    if (!isConnected || !controllerUsable) return;
    // Update currentR directly, let the loop handle sending
    currentR = value;
}

// ? Poll controller status from device
async function pollControllerStatus() {
    if (!isConnected) return;
    
    try {
        const usable = await invoke("poll_controller_status");
        if (usable !== controllerUsable) {
            addLog(`控制器状态变化: ${usable ? '可操控' : '不可操控'}`, usable ? "success" : "warning");
        }
        updateControllerStatus(usable);
    } catch (error) {
        addLog(`轮询状态失败: ${error}`, "error");
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
        
        addLog("正在测试设备通信...", "info");
        try {
            const usable = await invoke("poll_controller_status");
            addLog(`设备通信测试成功，控制器状态: ${usable ? '可操控' : '不可操控'}`, "success");
        } catch (pollError) {
            addLog(`设备通信测试失败: ${pollError}`, "error");
        }
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

// ? Role start command
async function startRole() {
    if (!isConnected) {
        addLog("设备未连接，无法执行起步", "warning");
        return;
    }

    try {
        addLog("执行起步命令...", "info");
        await invoke("send_arm_command", { command: "start" });
        addLog("✓ 角色已起步", "success");
    } catch (error) {
        addLog(`起步失败: ${error}`, "error");
    }
}

// ? Initialize device selection dropdown
async function initDeviceSelection() {
    try {
        // Clear existing options except the first one
        while (deviceSelect.options.length > 1) {
            deviceSelect.remove(1);
        }
        
        // Add known devices
        // Use a Set to avoid duplicates
        const seen = new Set();
        
        KNOWN_DEVICES.forEach(device => {
            if (device.address && !seen.has(device.address)) {
                const option = document.createElement("option");
                option.value = device.address;
                option.textContent = `${device.name} (${device.address})`; // Show address in name for clarity
                // Default is not selected, so the placeholder remains selected
                deviceSelect.appendChild(option);
                seen.add(device.address);
            }
        });
        
        addLog(`加载了 ${seen.size} 个预设设备`, "info");
    } catch (error) {
        addLog(`初始化设备列表失败: ${error}`, "error");
    }
}

// ! Application initialization
window.addEventListener("DOMContentLoaded", async () => {
    addLog("虚拟摇杆应用已启动", "success");
    
    // Initialize device selection
    await initDeviceSelection();
    
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
    connectDefaultBtn.addEventListener("click", () => {
        const selected = deviceSelect.value;
        const custom = customMacInput.value.trim();
        const target = custom || selected;

        if (target) {
            connectToDevice(target);
        } else {
            addLog("请选择或输入设备地址", "warning");
        }
    });
    disconnectBtn.addEventListener("click", disconnect);
    
    bindInstantButton(throwBtn, throwArm);
    bindInstantButton(startBtn, startRole);
    const liftingSliders = [
        { el: liftingSliderClaw, channel: 'Claw' },
        { el: liftingSliderA, channel: 'A' },
        { el: liftingSliderB, channel: 'B' },
        { el: liftingSliderC, channel: 'C' },
        { el: liftingSliderEnd, channel: 'End' },
    ];
    liftingSliders.forEach(({ el, channel }) => {
        if (el) {
            const handleLiftingInput = (event) => {
                const value = Number(event.target.value);
                updateLiftingDisplay(value);
                queueLiftingSend(channel, value);
            };
            el.min = LIFTING_MIN;
            el.max = LIFTING_MAX;
            el.value = LIFTING_MIN;
            el.addEventListener("input", handleLiftingInput);
            el.addEventListener("change", handleLiftingInput);
        }
    });
    updateLiftingDisplay(LIFTING_MIN);
    setLiftingSliderEnabled(false);

    // Bind rotation slider events
    if (rotationSlider) {
        const handleRotationInput = (event) => {
            const value = Number(event.target.value);
            updateRotationDisplay(value);
            queueRotationSend(value);
        };
        const handleRotationEnd = () => {
            // Reset to center when released
            rotationSlider.value = JOYSTICK_ZERO_VALUE;
            updateRotationDisplay(JOYSTICK_ZERO_VALUE);
            currentR = JOYSTICK_ZERO_VALUE;
            // ? Set resend counter
            zeroResendCount = 5;
        };
        rotationSlider.min = 0;
        rotationSlider.max = 255;
        rotationSlider.value = JOYSTICK_ZERO_VALUE;
        updateRotationDisplay(JOYSTICK_ZERO_VALUE);
        setRotationSliderEnabled(false);
        rotationSlider.addEventListener("input", handleRotationInput);
        rotationSlider.addEventListener("change", handleRotationEnd);
        rotationSlider.addEventListener("mouseup", handleRotationEnd);
        rotationSlider.addEventListener("touchend", handleRotationEnd);
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
});
