#!/usr/bin/env python3
import sys
import requests
import asyncio
import time
import random
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout,
    QPushButton, QFrame, QLabel, QSizePolicy, QSpacerItem,
    QSystemTrayIcon, QMenu, QAction
)
from PyQt5.QtCore import Qt, QTimer, QThread, pyqtSignal
from PyQt5.QtGui import QIcon
from webrtc_pipeline import WebRTCWorker

class PixelStreamerApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.code = None
        self.preview_frame = None
        self.initUI()

    def initUI(self):
        self.setWindowTitle("PixelStreamer")
        self.resize(2560, 1600)
        self.setStyleSheet("background-color: #18181a;")

        central_widget = QWidget()
        main_layout = QHBoxLayout()
        central_widget.setLayout(main_layout)
        self.setCentralWidget(central_widget)
        self.create_tray_icon()

        sidebar = QWidget()
        sidebar_layout = QVBoxLayout()
        sidebar_layout.setContentsMargins(50, 185, 50, 100)
        sidebar_layout.setSpacing(100)
        sidebar.setLayout(sidebar_layout)
        sidebar.setFixedWidth(800)
        sidebar.setStyleSheet("background-color: transparent;")

        self.buttons = ["Generate Code", "Hide Into Tray", "Webcam", "Microphone"]
        self.button_widgets = {}

        for label in self.buttons:
            button = QPushButton(label)
            button.setStyleSheet("""
                QPushButton {
                    background-color: #4876ff;
                    color: white;
                    border: none;
                    border-radius: 50px;
                    font-size: 80px;
                    padding: 50px;
                }
                QPushButton:hover {
                    background-color: #5A7EFF;
                }
            """)
            button.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            button.setFixedWidth(700)
            button.clicked.connect(lambda checked, b=button: self.on_button_click(b))
            sidebar_layout.addWidget(button)
            self.button_widgets[label] = button

        self.connection_status = QLabel("Connection: Not Connected")
        self.connection_status.setStyleSheet("""
            QLabel {
                color: #E74C3C;
                font-size: 50px;
                font-weight: bold;
            }
        """)
        sidebar_layout.addWidget(self.connection_status)

        sidebar_layout.addSpacerItem(QSpacerItem(20, 40, QSizePolicy.Minimum, QSizePolicy.Expanding))

        preview_container = QVBoxLayout()
        preview_container.setContentsMargins(20, 40, 40, 40)
        preview_container.setSpacing(10)

        preview_label = QLabel("Preview")
        preview_label.setStyleSheet("""
            QLabel {
                color: white;
                font-size: 100px;
                font-weight: bold;
            }
        """)
        preview_label.setAlignment(Qt.AlignLeft)

        self.preview_frame = QWidget()
        self.preview_frame.setStyleSheet("""
            QWidget {
                background-color: #777777;
                border-radius: 50px;
            }
        """)
        self.preview_frame.setMinimumSize(600, 400)
        self.preview_frame.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        # Create a layout for the preview frame to hold the GStreamer video widget
        self.preview_layout = QVBoxLayout()
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
            self.poll_for_offer()

    def request_code(self):
        try:
            response = requests.post("https://generatecode-qaf2yvcrrq-uc.a.run.app")
            response.raise_for_status()
            return response.json()['code']
        except Exception as e:
            print(f"Failed to generate code: {e}")
            return "Error"

    def poll_for_offer(self):
        self.poll_attempt = 0
        self.max_attempts = 30
        self.base_delay = 1.0
        self.max_delay = 30.0
        self.poll_timer = QTimer()
        self.poll_timer.setSingleShot(True)

        def poll():
            print(f"[Polling] Attempt {self.poll_attempt + 1}")
            try:
                response = requests.post("https://checkoffer-qaf2yvcrrq-uc.a.run.app", json={"code": self.code}, timeout=5)
                if response.status_code == 200:
                    print("✅ Offer received! Starting connection thread...")
                    win_id = int(self.preview_frame.winId())
                    self.worker = WebRTCWorker(code=self.code, widget_win_id=win_id, offer=response.json()["offer"])
                    self.worker.connection_state_changed.connect(self.update_connection_status)
                    self.worker.start()
                    return
                elif response.status_code == 204:
                    print("🕐 Not ready yet...")
                else:
                    print(f"⚠️ Unexpected status: {response.status_code}")
            except Exception as e:
                print(f"❌ Poll error: {e}")

            self.poll_attempt += 1
            if self.poll_attempt >= self.max_attempts:
                print("⛔ Gave up waiting for offer.")
                return

            delay = random.uniform(0, min(self.max_delay, self.base_delay * (2 ** self.poll_attempt)))
            print(f"🔁 Retrying in {delay:.2f} seconds...")
            self.poll_timer.start(int(delay * 1000))

        self.poll_timer.timeout.connect(poll)
        poll()

    def update_connection_status(self, state):
        print(f"Connection state update: {state}")
        if state == "connected":
            self.connection_status.setText("Connection: Connected")
            self.connection_status.setStyleSheet("""
                QLabel {
                    color: #2ECC71;
                    font-size: 50px;
                    font-weight: bold;
                }
            """)
        elif state == "connecting":
            self.connection_status.setText("Connection: Connecting...")
            self.connection_status.setStyleSheet("""
                QLabel {
                    color: #F39C12;
                    font-size: 50px;
                    font-weight: bold;
                }
            """)
        elif state == "failed" or state == "disconnected" or state == "closed":
            self.connection_status.setText(f"Connection: {state.capitalize()}")
            self.connection_status.setStyleSheet("""
                QLabel {
                    color: #E74C3C;
                    font-size: 50px;
                    font-weight: bold;
                }
            """)

    def handle_code_deletion(self, button):
        self.delete_code()
        button.setText(self.buttons[0])
        button.setEnabled(True)

    def delete_code(self):
        try:
            if self.code is None:
                return
                
            requests.post("https://deletecode-qaf2yvcrrq-uc.a.run.app", json={"code": self.code})
            self.code = None
        except Exception as e:
            print(f"Failed to delete code: {e}")

    def closeEvent(self, event):
        self.delete_code()
        event.accept()


def main():
    app = QApplication(sys.argv)
    window = PixelStreamerApp()
    window.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()