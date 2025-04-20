#!/usr/bin/env python3
import sys
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QPushButton, QFrame, QLabel, QSizePolicy, QSpacerItem, QSystemTrayIcon, QMenu, QAction, QMessageBox)
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QFont, QIcon
import requests

class PixelStreamerApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.code = None
        # servers = [
        #     iceServers: {
        #         urls: ['stun:stun1.1.google.com:19302', 'stun:stun2.1.google.com:19302']
        #     }
        # ]
        self.initUI()

    def initUI(self):
        # Main Window
        self.setWindowTitle("PixelStreamer")
        self.resize(2560, 1600)
        self.setStyleSheet("background-color: #18181a;")

        # Main Frame
        central_widget = QWidget()
        main_layout = QHBoxLayout()
        central_widget.setLayout(main_layout)
        self.setCentralWidget(central_widget)
        self.create_tray_icon()

        # Sidebar
        sidebar = QWidget()
        sidebar_layout = QVBoxLayout()
        sidebar_layout.setContentsMargins(50, 185, 50, 100)
        sidebar_layout.setSpacing(100)
        sidebar.setLayout(sidebar_layout)
        sidebar.setFixedWidth(800)
        sidebar.setStyleSheet("background-color: transparent;")

        # Button names
        self.buttons = [
            "Generate Code",
            "Hide Into Tray",
            "Webcam",
            "Microphone"
        ]

        # Create buttons
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

        # Spacer to push buttons to the top
        sidebar_layout.addSpacerItem(QSpacerItem(20, 40, QSizePolicy.Minimum, QSizePolicy.Expanding))

        # Preview area
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

        preview_frame = QFrame()
        preview_frame.setStyleSheet("""
            QFrame {
                background-color: #777777;
                border-radius: 50px;
            }
        """)
        preview_frame.setMinimumSize(600, 400)
        preview_frame.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        preview_container.addWidget(preview_label)
        preview_container.addWidget(preview_frame)

        main_layout.addWidget(sidebar)
        main_layout.addLayout(preview_container)

    def create_tray_icon(self):
        self.tray_icon = QSystemTrayIcon(self)
        self.tray_icon.setIcon(QIcon("./assets/icon.png"))

        tray_menu = QMenu()

        self.generate_code_action = QAction("Generate Code", self) if self.code == None else QAction(self.code, self)
        self.generate_code_action.triggered.connect(self.show_main_window)
        tray_menu.addAction(self.generate_code_action)

        camera_action = QAction("Toggle Camera", self)
        camera_action.triggered.connect(self.show_main_window)
        tray_menu.addAction(camera_action)

        microphone_action = QAction("Toggle Microphone", self)
        microphone_action.triggered.connect(self.show_main_window)
        tray_menu.addAction(microphone_action)

        restore_action = QAction("Show", self)
        restore_action.triggered.connect(self.show_main_window)
        tray_menu.addAction(restore_action)

        quit_action = QAction("Quit", self)
        quit_action.triggered.connect(QApplication.quit)
        tray_menu.addAction(quit_action)

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
        self.generate_code_action = QAction(self.code, self)

    def request_code(self):
        try:
            response = requests.post("https://generatecode-qaf2yvcrrq-uc.a.run.app")
            response.raise_for_status()
            return response.json()['code']
        except Exception as e:
            print(f"Failed to generate code: {e}")
            return "Error"

    def handle_code_deletion(self, button):
        self.delete_code()
        button.setText(self.buttons[0])
        button.setEnabled(True)
        QAction("Generate Code", self)
        
    def delete_code(self):
        try:
            if (self.code == None):
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