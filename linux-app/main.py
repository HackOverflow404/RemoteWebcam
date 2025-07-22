#!/usr/bin/env python3
from app import PixelStreamerApp
from PySide6.QtWidgets import QApplication
import sys

def main():
    app = QApplication(sys.argv)
    window = PixelStreamerApp()
    window.show()
    
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
