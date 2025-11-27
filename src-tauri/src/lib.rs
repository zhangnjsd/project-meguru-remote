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

// Define default settings.
const SERVICE_UUID: Uuid = Uuid::from_bytes([0xA1, 0xC6, 0xE6, 0xD4, 0x11, 0x45, 0x19, 0x19, 0x19, 0x19, 0x11, 0x45, 0x14, 0x19, 0x81, 0x00]);
const X_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0x05, 0x91, 0xB3, 0x6B, 0x11, 0x45, 0x19, 0x19, 0x19, 0x19, 0x11, 0x45, 0x14, 0x19, 0x81, 0x00]);
const Y_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0xD3, 0x09, 0xD1, 0x5D, 0x11, 0x45, 0x19, 0x19, 0x19, 0x19, 0x11, 0x45, 0x14, 0x19, 0x81, 0x00]);
const CONTROLLER_USABLE_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0xE7, 0xA1, 0xC2, 0xB3, 0x11, 0x45, 0x19, 0x19, 0x19, 0x19, 0x11, 0x45, 0x14, 0x19, 0x81, 0x00]);
const LIFTING_ARM_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0xA7, 0xA9, 0xD7, 0xE3, 0x11, 0x45, 0x19, 0x19, 0x19, 0x19, 0x11, 0x45, 0x14, 0x19, 0x81, 0x00]);
const MCLAW_SWITCH_CHARACTERISTIC_UUID: Uuid = Uuid::from_bytes([0xE2, 0xD3, 0xD4, 0xC4, 0x11, 0x45, 0x19, 0x19, 0x19, 0x19, 0x11, 0x45, 0x14, 0x19, 0x81, 0x00]);
const DEVICE_ADDRESS: &str = "98:88:E0:10:BC:3E";
const MAXIUM_DISCOVER_PERIOD: u64 = 20000; // in milliseconds

pub struct ArmData {
    pub x: u16,
    pub y: u16,
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
*/
#[tauri::command]
async fn poll_controller_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let data = receive_data(CONTROLLER_USABLE_CHARACTERISTIC_UUID, SERVICE_UUID)
        .await
        .map_err(|e| format!("Failed to read controller status: {}", e))?;
    
    // Explicitly check both cases for clarity
    let usable = if data.is_empty() {
        false
    } else if data[0] == CONTROLLER_USABLE {
        true
    } else if data[0] == CONTROLLER_NOT_USABLE {
        false
    } else {
        // Unknown value, default to not usable
        info!("Unknown controller status value: 0x{:02X}", data[0]);
        false
    };
    
    set_controller_usable(state, usable).await?;
    
    Ok(usable)
}

/*
    Send joystick X and Y values to device.
    x and y should be in range 0x00 to 0xFF, with 0x7F being center/zero position.
*/
#[tauri::command]
async fn send_joystick_data(state: tauri::State<'_, AppState>, x: u8, y: u8) -> Result<String, String> {
    // Check if controller is usable before sending
    let usable = {
        let controller_usable = state.controller_usable.lock().unwrap();
        *controller_usable
    };
    
    if !usable {
        return Err("Controller is not usable, cannot send joystick data".to_string());
    }
    
    // Send X value
    write_data(X_CHARACTERISTIC_UUID, SERVICE_UUID, vec![x])
        .await
        .map_err(|e| format!("Failed to write X value: {}", e))?;
    
    // Send Y value
    write_data(Y_CHARACTERISTIC_UUID, SERVICE_UUID, vec![y])
        .await
        .map_err(|e| format!("Failed to write Y value: {}", e))?;
    
    Ok(format!("Joystick data sent: X={}, Y={}", x, y))
}

#[tauri::command]
async fn send_lifting_arm_value(value: u8) -> Result<String, String> {
    write_data(LIFTING_ARM_CHARACTERISTIC_UUID, SERVICE_UUID, vec![value])
        .await
        .map_err(|e| format!("Failed to write lifting arm value: {}", e))?;

    Ok(format!("Lifting arm value sent: {}", value))
}

#[tauri::command]
async fn send_arm_command(command: String) -> Result<String, String> {
    let value = match command.as_str() {
        "grab" => 0x01,
        "release" => 0x00,
        _ => return Err(format!("Unsupported arm command: {}", command)),
    };

    write_data(MCLAW_SWITCH_CHARACTERISTIC_UUID, SERVICE_UUID, vec![value])
        .await
        .map_err(|e| format!("Failed to write arm command {:?}: {}", command, e))?;

    Ok(format!("Arm command '{}' sent with value 0x{:02X}", command, value))
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
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| format!("Get handle failed: {}", e))?;

    match handler.connect(addr, OnDisconnectHandler::None, false).await {
        Err(e) => {
            return Err(format!("Connect {:?} error occurred: {}", addr, e));
        }
        Ok(_) => {
            set_connected_device_address(state.clone(), addr.to_string()).await?;
            *state.is_connected.lock().unwrap() = true;
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
    // Send zero values before disconnecting
    info!("Sending zero values before disconnect...");
    if let Err(e) = write_data(X_CHARACTERISTIC_UUID, SERVICE_UUID, vec![JOYSTICK_ZERO_VALUE]).await {
        info!("Failed to send X zero value: {}", e);
    }
    if let Err(e) = write_data(Y_CHARACTERISTIC_UUID, SERVICE_UUID, vec![JOYSTICK_ZERO_VALUE]).await {
        info!("Failed to send Y zero value: {}", e);
    }
    
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| format!("Get handle failed: {}", e))?;

    match handler.disconnect().await {
        Err(e) => {
            return Err(format!("Disconnect failed: {}", e));
        }
        Ok(_) => {
            // Reset all state after successful disconnect
            set_connected_device_address(state.clone(), "".to_string()).await?;
            *state.is_connected.lock().unwrap() = false;
            set_controller_usable(state.clone(), false).await?;
        }
    }

    Ok(format!("Disconnected device and reset state"))
}

#[tauri::command]
async fn write_data(char_uuid: Uuid, service: Uuid, data: Vec<u8>) -> Result<String, String> {
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| format!("Get handle failed: {}", e))?;

    handler
        .send_data(char_uuid, Some(service), &data, WriteType::WithResponse)
        .await
        .map_err(|e| format!("Send {:?} to {:?} (Service: {:?}) failed: {}", data, char_uuid, service, e))?;

    Ok(format!("Successfully write data {:?} to {:?}.", data, service))
}

#[tauri::command]
async fn receive_data(char_uuid: Uuid, service: Uuid) -> Result<Vec<u8>, String> {
    let handler = tauri_plugin_blec::get_handler()
        .map_err(|e| format!("Get handle failed: {}", e))?;

    let response = handler
        .recv_data(char_uuid, Some(service))
        .await
        .map_err(|e| format!("Receive data from {:?} (Service: {:?}) failed: {}", char_uuid, service, e))?;

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
    info!("Starting scan for device: {}", DEVICE_ADDRESS);
    
    // Start scanning with monitoring
    let mut rx = scan_with_monitor().await?;
    
    // Monitor scan results
    let target_address = DEVICE_ADDRESS.to_uppercase();
    
    while let Some(devices) = rx.recv().await {
        info!("Discovered {} device(s)", devices.len());
        
        // Check if target device is in the discovered devices
        for device in devices {
            let device_address = device.address.to_uppercase();
            info!("Found device: {} (Name: {:?})", device_address, device.name);
            
            if device_address == target_address {
                info!("Target device found: {}", device_address);
                
                // Stop scanning immediately using stop_scan function
                stop_scan().await.unwrap_or_else(|e| {
                    info!("Failed to stop scan: {}", e);
                    e
                });
                
                // Connect to the device using connect function
                match connect(state.clone(), &device.address).await {
                    Ok(_) => {
                        info!("Successfully connected to {}", device.address);
                        
                        // Get current usable state from device
                        match receive_data(CONTROLLER_USABLE_CHARACTERISTIC_UUID, SERVICE_UUID).await {
                            Ok(data) => {
                                let usable = !data.is_empty() && data[0] == CONTROLLER_USABLE;
                                set_controller_usable(state, usable).await?;
                                info!("Controller usable: {}", usable);
                            }
                            Err(e) => {
                                info!("Failed to get controller status: {}", e);
                            }
                        }
                        
                        return Ok(());
                    }
                    Err(e) => {
                        return Err(format!("Connect failed: {}", e));
                    }
                }
            }
        }
    }
    
    // If we exit the loop, it means scan period ended without finding the device
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
