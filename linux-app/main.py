#!/usr/bin/env python3
import signal
import sys

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from app import PixelStreamerApp


def main():
    app = QApplication(sys.argv)
    window = PixelStreamerApp()
    app.aboutToQuit.connect(window.shutdown)
    # Ctrl+C in the terminal: quit cleanly so the virtual mic modules and the
    # pairing code are cleaned up. The timer lets Python see the signal while
    # Qt's event loop is running.
    signal.signal(signal.SIGINT, lambda *_: app.quit())
    signal.signal(signal.SIGTERM, lambda *_: app.quit())
    timer = QTimer()
    timer.start(250)
    timer.timeout.connect(lambda: None)

    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
