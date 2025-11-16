const { invoke } = window.__TAURI__.core;

// DOM element references
const connectionStatus = document.querySelector("#connection-status");
const connectDefaultBtn = document.querySelector("#connect-default-btn");
const disconnectBtn = document.querySelector("#disconnect-btn");
const controllerStatus = document.querySelector("#controller-status");
const joystickValues = document.querySelector("#joystick-values");
const joystickContainer = document.querySelector("#joystick-container");
const joystickBase = document.querySelector("#joystick-base");
const joystickStick = document.querySelector("#joystick-stick");
const logContainer = document.querySelector("#log-container");

// Configuration constants
const DEFAULT_CONNECT_DEVICE_MAC = "98:88:E0:10:BC:3E";
const JOYSTICK_ZERO_VALUE = 0x7F; // 127
const POLL_INTERVAL = 100; // Poll controller status every 100ms
const SEND_INTERVAL = 50; // Send joystick data every 50ms

// Application state
let isConnected = false;
let controllerUsable = false;
let pollIntervalId = null;
let sendIntervalId = null;

// Joystick state
let joystickActive = false;
let currentX = JOYSTICK_ZERO_VALUE;
let currentY = JOYSTICK_ZERO_VALUE;

// Add log message to UI
function addLog(message, type = "info") {
    const entry = document.createElement("p");
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

// Update connection status and UI
function updateConnectionStatus(connected, address = null) {
    isConnected = connected;
    if (connected) {
        connectionStatus.textContent = `✓ 已连接: ${address}`;
        connectionStatus.style.color = "#28a745";
        disconnectBtn.disabled = false;
        connectDefaultBtn.disabled = true;
        
        // Start polling controller status
        startPolling();
    } else {
        connectionStatus.textContent = "✗ 未连接";
        connectionStatus.style.color = "#dc3545";
        disconnectBtn.disabled = true;
        connectDefaultBtn.disabled = false;
        
        // Stop polling
        stopPolling();
        updateControllerStatus(false);
    }
}

// Update controller usable status
function updateControllerStatus(usable) {
    controllerUsable = usable;
    if (usable) {
        controllerStatus.textContent = "● 可操控";
        controllerStatus.style.color = "#28a745";
        joystickContainer.classList.remove("joystick-disabled");
        
        // Start sending joystick data
        if (!sendIntervalId) {
            sendIntervalId = setInterval(sendJoystickData, SEND_INTERVAL);
        }
    } else {
        controllerStatus.textContent = "● 不可操控";
        controllerStatus.style.color = "#dc3545";
        joystickContainer.classList.add("joystick-disabled");
        
        // Stop sending joystick data
        if (sendIntervalId) {
            clearInterval(sendIntervalId);
            sendIntervalId = null;
        }
        
        // Reset joystick to center
        resetJoystick();
    }
}

// Update joystick value display
function updateJoystickDisplay(x, y) {
    joystickValues.textContent = `X: ${x} (0x${x.toString(16).toUpperCase().padStart(2, '0')}) | Y: ${y} (0x${y.toString(16).toUpperCase().padStart(2, '0')})`;
}

// Reset joystick to center position
function resetJoystick() {
    joystickStick.style.left = "50%";
    joystickStick.style.top = "50%";
    currentX = JOYSTICK_ZERO_VALUE;
    currentY = JOYSTICK_ZERO_VALUE;
    updateJoystickDisplay(currentX, currentY);
}

// Convert screen position to joystick value (0x00 - 0xFF)
function positionToValue(position, max) {
    // position: -1 to 1 (center is 0)
    // Convert to 0x00 (0) to 0xFF (255), with 0x7F (127) as center
    const value = Math.round((position + 1) * 127.5);
    return Math.max(0, Math.min(255, value));
}

// Handle joystick movement
function handleJoystickMove(clientX, clientY) {
    if (!controllerUsable) return;
    
    const rect = joystickBase.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    let deltaX = clientX - centerX;
    let deltaY = clientY - centerY;
    
    const maxRadius = rect.width / 2 - 25; // Subtract stick radius
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

// Start joystick interaction
function startJoystick(event) {
    if (!controllerUsable) return;
    
    joystickActive = true;
    joystickStick.classList.add("active");
    
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const clientY = event.touches ? event.touches[0].clientY : event.clientY;
    handleJoystickMove(clientX, clientY);
    
    event.preventDefault();
}

// Move joystick
function moveJoystick(event) {
    if (!joystickActive) return;
    
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const clientY = event.touches ? event.touches[0].clientY : event.clientY;
    handleJoystickMove(clientX, clientY);
    
    event.preventDefault();
}

// Stop joystick interaction
function stopJoystick() {
    if (!joystickActive) return;
    
    joystickActive = false;
    joystickStick.classList.remove("active");
    
    // Reset to center with animation
    resetJoystick();
}

// Send joystick data to backend
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

// Poll controller status from device
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

// Start polling controller status
function startPolling() {
    if (pollIntervalId) return;
    
    pollIntervalId = setInterval(pollControllerStatus, POLL_INTERVAL);
    addLog("开始轮询控制器状态", "info");
}

// Stop polling controller status
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

// Check Bluetooth permissions
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

// Auto scan and connect to default device
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

// Manually connect to specified device
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

// Disconnect Bluetooth connection
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

// Application initialization
window.addEventListener("DOMContentLoaded", async () => {
    addLog("虚拟摇杆应用已启动", "success");
    
    // Bind connection buttons
    connectDefaultBtn.addEventListener("click", () => connectToDevice(DEFAULT_CONNECT_DEVICE_MAC));
    disconnectBtn.addEventListener("click", disconnect);
    
    // Bind joystick events
    // Mouse events
    joystickBase.addEventListener("mousedown", startJoystick);
    window.addEventListener("mousemove", moveJoystick);
    window.addEventListener("mouseup", stopJoystick);
    
    // Touch events
    joystickBase.addEventListener("touchstart", startJoystick);
    window.addEventListener("touchmove", moveJoystick);
    window.addEventListener("touchend", stopJoystick);
    window.addEventListener("touchcancel", stopJoystick);
    
    // Check permissions and auto connect
    await checkPermissions();
    await autoConnect();
});
