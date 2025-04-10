#!/usr/bin/env python3
import sys
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QPushButton, QFrame, QLabel)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont

import requests
import json

class PixelStreamerApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.initUI()

    def initUI(self):
        # Set window properties
        self.setWindowTitle("PixelStreamer")
        self.setGeometry(300, 300, 1800, 1200)
        
        # Set overall window background to #171717
        self.setStyleSheet("""
            QMainWindow {
                background-color: #171717;
            }
        """)

        # Central widget and main layout
        central_widget = QWidget()
        main_layout = QHBoxLayout()
        central_widget.setLayout(main_layout)
        self.setCentralWidget(central_widget)

        # Sidebar for buttons
        sidebar = QWidget()
        sidebar_layout = QVBoxLayout()
        sidebar.setLayout(sidebar_layout)
        sidebar.setFixedWidth(400)

        # Buttons with specific styling
        self.buttons = [
            "Generate Code",
            "Hide Into Tray",
            "Webcam",
            "Microphone"
        ]

        for buttonLabel in self.buttons:
            button = QPushButton(buttonLabel)
            button.setStyleSheet("""
                QPushButton {
                    background-color: #4876ff;
                    color: white;
                    border: none;
                    border-radius: 20px;
                    text-align: center;
                    font-size: 40px;
                }
                QPushButton:hover {
                    background-color: #5A7EFF;
                }
            """)
            button.setFixedHeight(120)
            button.clicked.connect(lambda checked, b=button: self.on_button_click(b))
            sidebar_layout.addWidget(button)

        # Add stretching to push buttons to the top
        sidebar_layout.addStretch(1)

        # Preview area
        preview_frame = QFrame()
        preview_frame.setStyleSheet("""
            QFrame {
                background-color: #777777;
                border: none;
                text-align: center;
            }
        """)

        # Label for "Preview"
        preview_label = QLabel("Preview")
        preview_label.setStyleSheet("""
            QLabel {
                color: white;
                font-size: 50px;
                font-weight: bold;
            }
        """)

        # Preview layout
        preview_layout = QVBoxLayout()
        preview_layout.addWidget(preview_label)
        preview_frame.setLayout(preview_layout)

        # Add widgets to main layout
        main_layout.addWidget(sidebar)
        main_layout.addWidget(preview_frame)

    def on_button_click(self, button):
        if button.text() == self.buttons[0]:
            code = self.request_code(button)
            button.setText(code)
            return
        
        if not(button.text() in self.buttons) and len(button.text()) == 5:
            button.setText(self.buttons[0])
            return

    def request_code(self, btn):
        response = requests.post("https://generatecode-qaf2yvcrrq-uc.a.run.app")
        return response.json()['code']

def main():
    app = QApplication(sys.argv)
    main_window = PixelStreamerApp()
    main_window.show()
    sys.exit(app.exec_())

if __name__ == "__main__":
    main()