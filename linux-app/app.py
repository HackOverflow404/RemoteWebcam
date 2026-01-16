import requests
from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QWidget,
    QHBoxLayout,
    QVBoxLayout,
    QPushButton,
    QLabel,
    QSizePolicy,
    QSpacerItem,
    QSystemTrayIcon,
    QMenu,
)
from PySide6.QtCore import Qt, QTimer, Signal, Slot
from PySide6.QtGui import QFont, QIcon, QImage, QPixmap
from webrtc_pipeline import WebRTCWorker, ConnectionState
import numpy as np
import cv2


class PixelStreamerApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self._latest_frame = None
        self._frame_timer = QTimer(self)
        self._frame_timer.timeout.connect(self.render_latest_frame)
        self._frame_timer.start(33) 
        
        self.code = None
        self.worker = None
        self.initUI()

    def initUI(self):
        with open("./assets/style.qss", "r") as f:
            self.setStyleSheet(f.read())

        self.setWindowTitle("PixelStreamer")
        self.setGeometry(100, 100, 256, 160)
        self.font = QFont("Courier New")

        central_widget = QWidget()
        main_layout = QHBoxLayout()
        central_widget.setLayout(main_layout)
        self.setCentralWidget(central_widget)
        self.create_tray_icon()

        sidebar = QWidget()
        sidebar_layout = QVBoxLayout()
        sidebar_layout.setContentsMargins(20, 40, 20, 20)
        sidebar_layout.setSpacing(30)
        sidebar_layout.setAlignment(Qt.AlignHCenter)
        sidebar.setLayout(sidebar_layout)

        title = QLabel("PixelStreamer")
        title.setFont(self.font)
        sidebar_layout.addWidget(title)
        title.setObjectName("titleLabel")

        self.buttons = ["Generate Code", "Hide Into Tray", "Webcam", "Microphone"]
        self.button_widgets = {}

        for i, label in enumerate(self.buttons):
            button = QPushButton(label)
            button.setFont(self.font)
            button.setCursor(Qt.PointingHandCursor)
            button.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            if i > 1:
                button.setCheckable(True)
                button.setChecked(True)
                button.setEnabled(False)
            button.clicked.connect(lambda checked, b=button: self.on_button_click(b))
            sidebar_layout.addWidget(button)
            self.button_widgets[label] = button

        self.connection_status = QLabel("Connection: Not Connected")
        self.connection_status.setFont(self.font)
        self.connection_status.setObjectName("connectionStatus")
        sidebar_layout.addWidget(self.connection_status)

        sidebar_layout.addSpacerItem(
            QSpacerItem(20, 40, QSizePolicy.Minimum, QSizePolicy.Expanding)
        )

        preview_container = QVBoxLayout()
        preview_container.setContentsMargins(20, 40, 40, 40)
        preview_container.setSpacing(20)

        preview_label = QLabel("Preview")
        preview_label.setFont(self.font)
        preview_label.setAlignment(Qt.AlignLeft)
        preview_label.setObjectName("previewLabel")

        self.preview_frame = QWidget()
        self.preview_frame.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.preview_frame.setObjectName("previewFrame")
        preview_label.setBuddy(self.preview_frame)

        self.video_label = QLabel()
        self.video_label.setAlignment(Qt.AlignCenter)
        self.video_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.video_label.setScaledContents(True)

        # ADD IT TO THE PREVIEW FRAME

        # Create a layout for the preview frame to hold the GStreamer video widget
        self.preview_layout = QVBoxLayout()
        self.preview_layout.addWidget(self.video_label)
        self.preview_frame.setLayout(self.preview_layout)

        preview_container.addWidget(preview_label)
        preview_container.addWidget(self.preview_frame)

        main_layout.addWidget(sidebar)
        main_layout.addLayout(preview_container)

    def on_tray_activated(self, reason):
        if reason == QSystemTrayIcon.Trigger:  # left click
            self.show_main_window()
    
    def create_tray_icon(self):
        self.tray_icon = QSystemTrayIcon(self)
        self.tray_icon.setIcon(QIcon("./assets/icon.png"))

        tray_menu = QMenu()

        # --- Code action (dynamic: "Generate Code" <-> actual code) ---
        self.tray_action_code = tray_menu.addAction("Generate Code")
        self.tray_action_code.triggered.connect(self.on_tray_code_action)

        tray_menu.addSeparator()

        # --- Toggle Camera / Mic (checkable) ---
        self.tray_action_cam = tray_menu.addAction("Webcam")
        self.tray_action_cam.setCheckable(True)
        self.tray_action_cam.toggled.connect(self.on_tray_toggle_cam)

        self.tray_action_mic = tray_menu.addAction("Microphone")
        self.tray_action_mic.setCheckable(True)
        self.tray_action_mic.toggled.connect(self.on_tray_toggle_mic)

        tray_menu.addSeparator()

        # --- Show / Quit ---
        tray_menu.addAction("Show", self.show_main_window)
        tray_menu.addAction("Quit", self.handle_quit)

        self.tray_icon.setContextMenu(tray_menu)
        self.tray_icon.activated.connect(self.on_tray_activated)  # optional UX
        self.tray_icon.show()


    def show_main_window(self):
        self.show()
        self.raise_()
        self.activateWindow()
    
    def sync_tray_state(self):
        # Code action text
        if hasattr(self, "tray_action_code"):
            if self.code and self.code != "Error":
                self.tray_action_code.setText(self.code)
            else:
                self.tray_action_code.setText("Generate Code")

        # Sync toggle states from sidebar buttons
        cam_btn = self.button_widgets.get("Webcam")
        mic_btn = self.button_widgets.get("Microphone")

        if hasattr(self, "tray_action_cam") and cam_btn and cam_btn.isCheckable():
            self.tray_action_cam.blockSignals(True)
            self.tray_action_cam.setChecked(cam_btn.isChecked())
            self.tray_action_cam.setEnabled(cam_btn.isEnabled())
            self.tray_action_cam.blockSignals(False)

        if hasattr(self, "tray_action_mic") and mic_btn and mic_btn.isCheckable():
            self.tray_action_mic.blockSignals(True)
            self.tray_action_mic.setChecked(mic_btn.isChecked())
            self.tray_action_mic.setEnabled(mic_btn.isEnabled())
            self.tray_action_mic.blockSignals(False)
    
    def on_tray_code_action(self):
        """
        If no code: generate.
        If code exists: delete + reset.
        """
        # Prefer to reuse the existing button logic so behavior stays consistent.
        btn = self.button_widgets.get("Generate Code")

        if self.code is None:
            # Generate
            if btn:
                self.on_button_click(btn)
            else:
                # Fallback if you ever remove the button
                QTimer.singleShot(0, lambda: self.handle_code_generation(btn))
        else:
            # Delete
            if btn:
                # Ensure the same UI flow as clicking the button with code text
                btn.setText(self.code)
                self.on_button_click(btn)
            else:
                QTimer.singleShot(0, lambda: self.handle_code_deletion(btn))


    def on_tray_toggle_cam(self, checked: bool):
        # Sync sidebar button state
        btn = self.button_widgets.get("Webcam")
        if btn and btn.isCheckable() and btn.isChecked() != checked:
            btn.blockSignals(True)
            btn.setChecked(checked)
            btn.blockSignals(False)

        # Call worker if available
        if self.worker:
            try:
                self.worker.toggle_cam(checked)
            except Exception as e:
                print("toggle_cam failed:", e)

    def on_tray_toggle_mic(self, checked: bool):
        # Sync sidebar button state
        btn = self.button_widgets.get("Microphone")
        if btn and btn.isCheckable() and btn.isChecked() != checked:
            btn.blockSignals(True)
            btn.setChecked(checked)
            btn.blockSignals(False)

        # Call worker if available
        if self.worker:
            try:
                self.worker.toggle_mic(checked)
            except Exception as e:
                print("toggle_mic failed:", e)

    def on_button_click(self, button):
        if button.text() == self.buttons[0] or button.text() == "Error":
            button.setText("Generating...")
            button.setEnabled(False)
            QTimer.singleShot(100, lambda: self.handle_code_generation(button))
            return
        if self.code and button.text() == self.code:
            button.setText("Deleting...")
            button.setEnabled(False)
            QTimer.singleShot(100, lambda: self.handle_code_deletion(button))
            return
        if button.text() == self.buttons[1]:
            self.sync_tray_state()
            self.hide()

            # optional toast
            if self.code and self.code != "Error":
                self.tray_icon.showMessage(
                    "PixelStreamer",
                    f"Running in tray. Code: {self.code}",
                    QSystemTrayIcon.Information,
                    2000,
                )
            else:
                self.tray_icon.showMessage(
                    "PixelStreamer",
                    "Running in tray.",
                    QSystemTrayIcon.Information,
                    1500,
                )
            return
        if button.text() == self.buttons[2]:
            checked = button.isChecked()
            if hasattr(self, "tray_action_cam") and self.tray_action_cam.isChecked() != checked:
                self.tray_action_cam.blockSignals(True)
                self.tray_action_cam.setChecked(checked)
                self.tray_action_cam.blockSignals(False)
            if self.worker:
                self.worker.toggle_cam(checked)
            return
        if button.text() == self.buttons[3]:
            checked = button.isChecked()
            if hasattr(self, "tray_action_mic") and self.tray_action_mic.isChecked() != checked:
                self.tray_action_mic.blockSignals(True)
                self.tray_action_mic.setChecked(checked)
                self.tray_action_mic.blockSignals(False)
            if self.worker:
                self.worker.toggle_mic(checked)
            return

    def handle_code_generation(self, button):
        self.code = self.request_code()
        button.setText(self.code)
        button.setEnabled(True)
        
        if hasattr(self, "tray_action_code"):
            self.tray_action_code.setText(self.code if self.code != "Error" else "Generate Code")
        
        if self.code != "Error":
            self.worker = WebRTCWorker(code=self.code)
            self.worker.connection_state_changed.connect(self.on_connection_status)
            self.worker.video_frame_received.connect(self.on_frame)
            self.worker.start()

    def request_code(self):
        try:
            response = requests.post(
                "https://generatecode-qaf2yvcrrq-uc.a.run.app",
                timeout=5
            )
            response.raise_for_status()
            return response.json()["code"]
        except Exception as e:
            print(f"Failed to generate code: {e}")
            return "Error"

    @Slot(object)
    def on_connection_status(self, state):
        color_map = {
            ConnectionState.CONNECTED: "#2ECC71",
            ConnectionState.CONNECTING: "#F39C12",
            ConnectionState.DISCONNECTED: "#E74C3C",
            ConnectionState.FAILED: "#E74C3C",
        }

        if state == ConnectionState.DISCONNECTED:
            self.reset_session_ui()
        elif state == ConnectionState.CONNECTED:
            self.button_widgets.get("Microphone").setEnabled(True)
            self.button_widgets.get("Webcam").setEnabled(True)
        
        self.connection_status.setText(f"Connection: {state.value.capitalize()}")
        self.connection_status.setStyleSheet(f"color: {color_map[state]}")
        

    @Slot(object)
    def on_frame(self, frame: np.ndarray):
        if frame is None:
            return
        self._latest_frame = frame

    def render_latest_frame(self):
        frame = self._latest_frame
        if frame is None:
            return

        # Optional: clear so we don't re-render the same frame
        self._latest_frame = None

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb = np.ascontiguousarray(rgb)

        h, w, ch = rgb.shape
        bytes_per_line = ch * w

        image = QImage(rgb.data, w, h, bytes_per_line, QImage.Format_RGB888).copy()
        self.video_label.setPixmap(QPixmap.fromImage(image))


    def stop_worker(self):
        """Stop and fully tear down the current worker, if any."""
        w = self.worker
        if not w:
            return

        try:
            w.video_frame_received.disconnect(self.on_frame)
        except Exception:
            pass

        try:
            QTimer.singleShot(0, w.stop)
        except Exception as e:
            print("worker.stop() failed:", e)

        self.worker = None

    def reset_session_ui(self):
        if not self.worker and not self.code:
            return

        self.stop_worker()
        self.delete_code()

        btn = self.button_widgets.get("Generate Code")
        if btn:
            btn.setText("Generate Code")
            btn.setEnabled(True)
        
        self.button_widgets.get("Microphone").setChecked(True)
        self.button_widgets.get("Webcam").setChecked(True)
        self.button_widgets.get("Microphone").setEnabled(False)
        self.button_widgets.get("Webcam").setEnabled(False)

        if hasattr(self, "tray_action_code"):
            self.tray_action_code.setText("Generate Code")

        self.video_label.clear()
        self.code = None

    def handle_code_deletion(self, button):
        self.stop_worker()
        self.delete_code()
        
        if hasattr(self, "tray_action_code"):
            self.tray_action_code.setText("Generate Code")

        button.setText(self.buttons[0])
        button.setEnabled(True)

    def delete_code(self):
        try:
            if self.code is None:
                return

            requests.post(
                "https://deletecode-qaf2yvcrrq-uc.a.run.app", json={"code": self.code},
                timeout=5
            )
            self.code = None
        except Exception as e:
            print(f"Failed to delete code: {e}")

    def handle_quit(self):
        self.stop_worker()
        self.delete_code()
        QApplication.quit()
    
    def closeEvent(self, event):
        self.stop_worker()
        self.delete_code()
        event.accept()
