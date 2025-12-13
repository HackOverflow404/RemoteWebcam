#!/usr/bin/env python3
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
    QMenu
)
from PySide6.QtCore import Qt, QTimer, Signal, Slot
from PySide6.QtGui import QFont, QIcon, QImage, QPixmap
from webrtc_pipeline import WebRTCWorker, ConnectionState
import numpy as np
import cv2


class PixelStreamerApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.code = None
        self.worker = None
        self.poll_timer = None
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

        for label in self.buttons:
            button = QPushButton(label)
            button.setFont(self.font)
            button.setCursor(Qt.PointingHandCursor)
            button.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
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

    def create_tray_icon(self):
        self.tray_icon = QSystemTrayIcon(self)
        self.tray_icon.setIcon(QIcon("./assets/icon.png"))

        tray_menu = QMenu()
        tray_menu.addAction("Generate Code", self.show_main_window)
        tray_menu.addAction("Toggle Camera", self.show_main_window)
        tray_menu.addAction("Toggle Microphone", self.show_main_window)
        tray_menu.addAction("Show", self.show_main_window)
        tray_menu.addAction("Quit", QApplication.quit)

        self.tray_icon.setContextMenu(tray_menu)
        self.tray_icon.show()

    def show_main_window(self):
        self.show()
        self.raise_()
        self.activateWindow()

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
            self.hide()
            return

    def handle_code_generation(self, button):
        self.code = self.request_code()
        button.setText(self.code)
        button.setEnabled(True)
        if self.code != "Error":
            self.worker = WebRTCWorker(
                code=self.code, widget_win_id=int(self.preview_frame.winId())
            )
            self.worker.connection_state_changed.connect(self.update_connection_status)
            self.worker.video_frame_received.connect(self.on_frame)
            self.worker.start()

    def request_code(self):
        try:
            response = requests.post("https://generatecode-qaf2yvcrrq-uc.a.run.app")
            response.raise_for_status()
            return response.json()["code"]
        except Exception as e:
            print(f"Failed to generate code: {e}")
            return "Error"

    def update_connection_status(self, state):
        color_map = {
            ConnectionState.CONNECTED: "#2ECC71",
            ConnectionState.CONNECTING: "#F39C12",
            ConnectionState.DISCONNECTED: "#E74C3C",
            ConnectionState.FAILED: "#E74C3C",
        }

        if state == ConnectionState.DISCONNECTED:
            self.reset_session_ui()

        self.connection_status.setText(
            f"Connection: {state.value.capitalize()}"
        )
        self.connection_status.setStyleSheet(f"color: {color_map[state]}")

    @Slot(object)
    def on_frame(self, frame: np.ndarray):
        if frame is None:
            return

        h, w, ch = frame.shape
        bytes_per_line = ch * w

        # BGR → RGB (IMPORTANT)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        image = QImage(
            rgb.data,
            w,
            h,
            bytes_per_line,
            QImage.Format_RGB888,
        )

        self.video_label.setPixmap(QPixmap.fromImage(image))
    
    def reset_session_ui(self):
        if not self.worker:
            return
        
        self.worker.stop()
        self.worker = None

        # Delete backend code
        self.delete_code()

        # Reset code button
        btn = self.button_widgets.get("Generate Code")
        if btn:
            btn.setText("Generate Code")
            btn.setEnabled(True)

        # Clear preview
        self.video_label.clear()

        self.code = None

    def handle_code_deletion(self, button):
        self.delete_code()
        if self.poll_timer:
            self.poll_timer.stop()
        if self.worker:
            self.worker.stop()
        button.setText(self.buttons[0])
        button.setEnabled(True)

    def delete_code(self):
        try:
            if self.code is None:
                return

            requests.post(
                "https://deletecode-qaf2yvcrrq-uc.a.run.app", json={"code": self.code}
            )
            self.code = None
        except Exception as e:
            print(f"Failed to delete code: {e}")

    def closeEvent(self, event):
        if self.worker:
            self.worker.stop()
            self.worker = None
        self.delete_code()
        event.accept()
