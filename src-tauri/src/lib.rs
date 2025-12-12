use std::sync::Mutex;
use tokio::sync::mpsc;
use tracing::info;
use uuid::Uuid;
use tauri_plugin_blec::{OnDisconnectHandler, models::{ScanFilter, WriteType, BleDevice}};
use tauri::Manager;

/* 
// Transfer Standard UUID defined by bluetooth SIG to 128bit UUID format
const fn transfer_standard_u16_to_u128(value: u16) -> Uuid {
    let first: u8 = ((value >> 8) & 0xFF) as u8;
    let second: u8 = (value & 0xFF) as u8;
    Uuid::from_bytes([
        0x00, 0x00, first, second, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0x80, 0x5F, 0x9B, 0x34, 0xFB
    ])
}
*/

// ! Define default settings.
// Note: BLE UUID bytes must be reversed from C's little-endian BLE_UUID128_INIT to big-endian for Rust
const SERVICE_UUID: Uuid = Uuid::from_bytes([0x00, 0x81, 0x19, 0x14, 0x45, 0x11, 0x19, 0x19, 0x19, 0x19, 0x45, 0x11, 0xD4, 0xE6, 0xC6, 0xA1]);
const X_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0x00, 0x81, 0x19, 0x14, 0x45, 0x11, 0x19, 0x19, 0x19, 0x19, 0x45, 0x11, 0x6B, 0xB3, 0x91, 0x05]);
const Y_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0x00, 0x81, 0x19, 0x14, 0x45, 0x11, 0x19, 0x19, 0x19, 0x19, 0x45, 0x11, 0x5D, 0xD1, 0x09, 0xD3]);
const R_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0x00, 0x81, 0x19, 0x14, 0x45, 0x11, 0x19, 0x19, 0x19, 0x19, 0x45, 0x11, 0x4E, 0xC5, 0x2E, 0xF4]);
const CONTROLLER_USABLE_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0x00, 0x81, 0x19, 0x14, 0x45, 0x11, 0x19, 0x19, 0x19, 0x19, 0x45, 0x11, 0xB3, 0xC2, 0xA1, 0xE7]);
const LIFTING_ARM_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0x00, 0x81, 0x19, 0x14, 0x45, 0x11, 0x19, 0x19, 0x19, 0x19, 0x45, 0x11, 0xE3, 0xD7, 0xA9, 0xA7]);
const MCLAW_SWITCH_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0x00, 0x81, 0x19, 0x14, 0x45, 0x11, 0x19, 0x19, 0x19, 0x19, 0x45, 0x11, 0xC4, 0xD4, 0xD3, 0xE2]);
const DEVICE_ADDRESS: &str = "3c:0f:02:d1:d3:8a";
const MAXIUM_DISCOVER_PERIOD: u64 = 10000; // 10 seconds timeout for scanning

pub struct ArmData {
    pub x: u16,
    pub y: u16,
    pub r: u16,
    pub controller_usable: bool,
}

const JOYSTICK_ZERO_VALUE: u8 = 0x7F;
const CONTROLLER_USABLE: u8 = 0x01;
const CONTROLLER_NOT_USABLE: u8 = 0x00;

pub struct AppState {
    pub is_connected: Mutex<bool>,
    pub connected_address: Mutex<Option<String>>,
    pub controller_usable: Mutex<bool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            is_connected: Mutex::new(false),
            connected_address: Mutex::new(None),
            controller_usable: Mutex::new(false),
        }
    }
}

#[tauri::command]
async fn set_connected_device_address(state: tauri::State<'_, AppState>, address: String) -> Result<String, String> {
    let mut addr = state.connected_address.lock().unwrap();
    if address.is_empty() {
        *addr = None;
        return Ok("Connected device address cleared.".to_string());
    } else {
        *addr = Some(address);
        return Ok(format!("Connected device address {:?} set.", addr));
    }
}

#[tauri::command]
async fn get_connected_device_address(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let addr = state.connected_address.lock().unwrap();
    Ok(addr.clone().unwrap_or("No device connected".to_string()))
}

#[tauri::command]
async fn set_controller_usable(state: tauri::State<'_, AppState>, usable: bool) -> Result<String, String> {
    let mut controller_usable = state.controller_usable.lock().unwrap();
    *controller_usable = usable;
    Ok(format!("Controller usable state set to: {}", usable))
}

#[tauri::command]
async fn get_controller_usable(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let controller_usable = state.controller_usable.lock().unwrap();
    Ok(*controller_usable)
}

/*
    Poll controller usable status from device.
    Returns true if device is ready to receive joystick commands (0x01), false otherwise (0x00).
    Device may return 1 byte (0x01) or 2 bytes ([0x00, 0x01]).
*/
#[tauri::command]
async fn poll_controller_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    info!("Polling controller status...");
    
    let data = receive_data(CONTROLLER_USABLE_CHARACTERISTIC_UUID, SERVICE_UUID)
        .await
        .map_err(|e| {
            info!("Failed to read controller status: {}", e);
            format!("Failed to read controller status: {}", e)
        })?;
    
    info!("Received controller status data: {:?} (len={})", data, data.len());
    
    // Check the last byte for the actual value (handles both 1-byte and 2-byte formats)
    let usable = if data.is_empty() {
        info!("Controller status: empty data, treating as not usable");
        false
    } else {
        // Get the last byte (handles [0x01] or [0x00, 0x01] formats)
        let status_byte = *data.last().unwrap();
        info!("Controller status byte: 0x{:02X}", status_byte);
        
        if status_byte == CONTROLLER_USABLE {
            info!("Controller status: 0x01 (usable)");
            true
        } else if status_byte == CONTROLLER_NOT_USABLE {
            info!("Controller status: 0x00 (not usable)");
            false
        } else {
            // Unknown value, default to not usable
            info!("Unknown controller status value: 0x{:02X}, treating as not usable", status_byte);
            false
        }
    };
    
    set_controller_usable(state, usable).await?;
    
    Ok(usable)
}

/*
    Send joystick X and Y values to device.
    x and y should be in range 0x00 to 0xFF, with 0x7F being center/zero position.
    Device expects 2-byte data format: [0x00, value]
*/
#[tauri::command]
async fn send_joystick_data(state: tauri::State<'_, AppState>, x: u8, y: u8, r: u8) -> Result<String, String> {
    // Check if controller is usable before sending
    let usable = {
        let controller_usable = state.controller_usable.lock().unwrap();
        *controller_usable
    };
    
    if !usable {
        return Err("Controller is not usable, cannot send joystick data".to_string());
    }
    
    info!("Sending joystick data: X=0x{:02X}00, Y=0x{:02X}00, R=0x{:02X}00", x, y, r);
    
    // Send X value (2-byte format: [x, 0x00] - little endian)
    write_data(X_CHARACTERISTIC_UUID, SERVICE_UUID, vec![x, 0x00])
        .await
        .map_err(|e| {
            info!("Failed to write X value: {}", e);
            format!("Failed to write X value: {}", e)
        })?;
    
    info!("X value sent successfully");
    
    // Send Y value (2-byte format: [y, 0x00] - little endian)
    write_data(Y_CHARACTERISTIC_UUID, SERVICE_UUID, vec![y, 0x00])
        .await
        .map_err(|e| {
            info!("Failed to write Y value: {}", e);
            format!("Failed to write Y value: {}", e)
        })?;
    
    info!("Y value sent successfully");

    write_data(R_CHARACTERISTIC_UUID, SERVICE_UUID, vec![r, 0x00])
        .await
        .map_err(|e| {
            info!("Failed to write R value: {}", e);
            format!("Failed to write R value: {}", e)
        })?;
    
    info!("R value sent successfully");
    
    Ok(format!("Joystick data sent: X={}, Y={}, R={}", x, y, r))
}

#[tauri::command]
async fn send_lifting_arm_value(value: u8) -> Result<String, String> {
    // Device expects 2-byte data format: [value, 0x00] - little endian
    write_data(LIFTING_ARM_CHARACTERISTIC_UUID, SERVICE_UUID, vec![value, 0x00])
        .await
        .map_err(|e| format!("Failed to write lifting arm value: {}", e))?;

    Ok(format!("Lifting arm value sent: 0x{:02X}00", value))
}

#[tauri::command]
async fn send_arm_command(command: String) -> Result<String, String> {
    let value = match command.as_str() {
        "grab" => 0x01,
        "release" => 0x00,
        _ => return Err(format!("Unsupported arm command: {}", command)),
    };

    // Device expects 2-byte data format: [value, 0x00] - little endian
    write_data(MCLAW_SWITCH_CHARACTERISTIC_UUID, SERVICE_UUID, vec![value, 0x00])
        .await
        .map_err(|e| format!("Failed to write arm command {:?}: {}", command, e))?;

    Ok(format!("Arm command '{}' sent with value 0x{:02X}00", command, value))
}

/*
    Stop scan device if some error occurred.
*/
#[tauri::command]
async fn stop_scan() -> Result<String, String> {
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| format!("Get handle failed: {}", e))?;

    handler
        .stop_scan()
        .await
        .map_err(|e| format!("Stop scan failed: {}", e))?;

    Ok(format!("Scan terminated."))
}


/*
    Connect to device.
*/
#[tauri::command]
async fn connect(state: tauri::State<'_, AppState>, addr: &str) -> Result<String, String> {
    info!("connect() called with address: {}", addr);
    
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| {
            info!("connect: Get handle failed: {}", e);
            format!("Get handle failed: {}", e)
        })?;
    
    info!("Got handler, attempting connection...");

    match handler.connect(addr, OnDisconnectHandler::None, false).await {
        Err(e) => {
            info!("connect: Connection failed: {}", e);
            return Err(format!("Connect {:?} error occurred: {}", addr, e));
        }
        Ok(_) => {
            info!("connect: Connection successful, updating state...");
            set_connected_device_address(state.clone(), addr.to_string()).await?;
            *state.is_connected.lock().unwrap() = true;
            info!("connect: State updated");
        }
    }

    Ok(format!("Connected device: {}", addr))
}


/*
    Disconnect from device.
    Before disconnecting, turn off the light and reset state.
*/
#[tauri::command]
async fn disconnect(state: tauri::State<'_, AppState>) -> Result<String, String> {
    // Send zero values before disconnecting (2-byte format: [value, 0x00] - little endian)
    info!("Sending zero values before disconnect...");
    if let Err(e) = write_data(X_CHARACTERISTIC_UUID, SERVICE_UUID, vec![JOYSTICK_ZERO_VALUE, 0x00]).await {
        info!("Failed to send X zero value: {}", e);
    }
    if let Err(e) = write_data(Y_CHARACTERISTIC_UUID, SERVICE_UUID, vec![JOYSTICK_ZERO_VALUE, 0x00]).await {
        info!("Failed to send Y zero value: {}", e);
    }
    if let Err(e) = write_data(R_CHARACTERISTIC_UUID, SERVICE_UUID, vec![JOYSTICK_ZERO_VALUE, 0x00]).await {
        info!("Failed to send R zero value: {}", e);
    }
    
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| format!("Get handle failed: {}", e))?;

    match handler.disconnect().await {
        Err(e) => {
            return Err(format!("Disconnect failed: {}", e));
        }
        Ok(_) => {
            // ! Reset all state after successful disconnect
            set_connected_device_address(state.clone(), "".to_string()).await?;
            *state.is_connected.lock().unwrap() = false;
            set_controller_usable(state.clone(), false).await?;
        }
    }

    Ok(format!("Disconnected device and reset state"))
}

#[tauri::command]
async fn write_data(char_uuid: Uuid, service: Uuid, data: Vec<u8>) -> Result<String, String> {
    info!("write_data called - Characteristic: {}, Service: {}, Data: {:?}", char_uuid, service, data);
    
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| {
            info!("write_data: Get handle failed: {}", e);
            format!("Get handle failed: {}", e)
        })?;

    handler
        .send_data(char_uuid, Some(service), &data, WriteType::WithoutResponse)
        .await
        .map_err(|e| {
            info!("write_data: Send failed - Char: {}, Service: {}, Data: {:?}, Error: {}", char_uuid, service, data, e);
            format!("Send {:?} to {:?} (Service: {:?}) failed: {}", data, char_uuid, service, e)
        })?;

    info!("write_data: Successfully wrote data {:?} to {:?}", data, char_uuid);
    Ok(format!("Successfully write data {:?} to {:?}.", data, service))
}

#[tauri::command]
async fn receive_data(char_uuid: Uuid, service: Uuid) -> Result<Vec<u8>, String> {
    info!("receive_data called - Characteristic: {}, Service: {}", char_uuid, service);
    
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| {
            info!("receive_data: Get handle failed: {}", e);
            format!("Get handle failed: {}", e)
        })?;

    let response = handler
        .recv_data(char_uuid, Some(service))
        .await
        .map_err(|e| {
            info!("receive_data: Failed - Char: {}, Service: {}, Error: {}", char_uuid, service, e);
            format!("Receive data from {:?} (Service: {:?}) failed: {}", char_uuid, service, e)
        })?;

    info!("receive_data: Received data {:?} from {:?}", response, char_uuid);
    Ok(response)
}

/*
    Helper function to scan with channel for monitoring results.
    This is used internally by preload_operation.
*/
async fn scan_with_monitor() -> Result<mpsc::Receiver<Vec<BleDevice>>, String> {
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| format!("Get handle failed: {}", e))?;

    let (tx, rx) = mpsc::channel(10);

    handler
        .discover(Some(tx), MAXIUM_DISCOVER_PERIOD, ScanFilter::None, false)
        .await
        .map_err(|e| format!("Scan failed: {}", e))?;
    
    Ok(rx)
}

/*
    Scan for devices and auto-connect when target device is found.
    This function will monitor scan results and connect immediately when the target MAC address is discovered.
*/
#[tauri::command]
async fn preload_operation(state: tauri::State<'_, AppState>) -> Result<(), String> {
    info!("=== Starting preload_operation ===");
    info!("Target device: {}", DEVICE_ADDRESS);
    
    // ? Start scanning with monitoring
    info!("Starting scan...");
    let mut rx = scan_with_monitor().await?;
    info!("Scan started, waiting for devices...");
    
    // ? Monitor scan results
    let target_address = DEVICE_ADDRESS.to_uppercase();
    
    while let Some(devices) = rx.recv().await {
        info!("Received scan result: {} device(s)", devices.len());
        
        // * Check if target device is in the discovered devices
        for device in devices {
            let device_address = device.address.to_uppercase();
            info!("  - Device: {} (Name: {:?})", device_address, device.name);
            
            if device_address == target_address {
                info!(">>> Target device found! <<<");
                
                // * Stop scanning immediately
                info!("Stopping scan...");
                let _ = stop_scan().await;
                info!("Scan stopped");
                
                // * Connect to the device
                info!("Connecting to {}...", device.address);
                match connect(state.clone(), &device.address).await {
                    Ok(_) => {
                        info!("Connected successfully!");
                        
                        // * Get current usable state from device (use last byte)
                        info!("Reading controller status...");
                        match receive_data(CONTROLLER_USABLE_CHARACTERISTIC_UUID, SERVICE_UUID).await {
                            Ok(data) => {
                                let usable = !data.is_empty() && *data.last().unwrap() == CONTROLLER_USABLE;
                                set_controller_usable(state, usable).await?;
                                info!("Controller usable: {}", usable);
                            }
                            Err(e) => {
                                info!("Failed to get controller status: {}", e);
                            }
                        }
                        
                        info!("=== preload_operation completed successfully ===");
                        return Ok(());
                    }
                    Err(e) => {
                        info!("Connect failed: {}", e);
                        return Err(format!("Connect failed: {}", e));
                    }
                }
            }
        }
    }
    
    info!("=== preload_operation: scan timeout, device not found ===");
    Err(format!("Target device {} not found within scan period", DEVICE_ADDRESS))
}



#[tauri::command]
fn check_ble_permissions() -> Result<bool, String> {
    tauri_plugin_blec::check_permissions(true)
        .map_err(|e| format!("Permission check failed: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_blec::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            set_connected_device_address,
            get_connected_device_address,
            get_controller_usable,
            poll_controller_status,
            send_joystick_data,
            send_lifting_arm_value,
            send_arm_command,
            preload_operation,
            check_ble_permissions,
            disconnect,
            connect,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(|event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    tauri::async_runtime::spawn(async move {
                        // Perform disconnect logic directly without calling disconnect function
                        let handler = match tauri_plugin_blec::get_handler() {
                            Ok(h) => h,
                            Err(e) => {
                                info!("Error occurred when existing (get handler): {}", e);
                                return;
                            }
                        };
                        if let Err(e) = handler.disconnect().await {
                            info!("Error occurred when existing (disconnect): {}", e);
                        }
                    });
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
