import threading
from pathlib import Path

import numpy as np
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
from PySide6.QtCore import QObject, Qt, Signal, Slot
from PySide6.QtGui import QFont, QIcon, QImage, QPixmap

import api
from virtual_devices import VirtualCamThread, VirtualMicThread
from webrtc_pipeline import WebRTCWorker, ConnectionState

ASSETS = Path(__file__).resolve().parent / "assets"


class _Bridge(QObject):
    """Carries results from background threads onto the GUI thread."""
    preview = Signal(object)        # RGB ndarray or None
    code_ready = Signal(str)
    code_failed = Signal(str)


class PixelStreamerApp(QMainWindow):
    STATUS_COLORS = {
        ConnectionState.WAITING: "#F39C12",
        ConnectionState.CONNECTING: "#F39C12",
        ConnectionState.CONNECTED: "#2ECC71",
        ConnectionState.DISCONNECTED: "#E74C3C",
        ConnectionState.FAILED: "#E74C3C",
    }

    def __init__(self):
        super().__init__()
        self.code = None
        self.worker = None
        self._preview_image = None
        self._shut_down = False

        self._bridge = _Bridge()
        self._bridge.preview.connect(self.on_preview)
        self._bridge.code_ready.connect(self.on_code_ready)
        self._bridge.code_failed.connect(self.on_code_failed)

        self.initUI()

        # Virtual devices live for the whole app session so other apps keep
        # them selected across reconnects; between sessions they carry
        # black video / silence.
        self.cam = VirtualCamThread(on_preview=self._bridge.preview.emit)
        self.mic = VirtualMicThread()
        self.cam.start()
        self.mic.start()

    # ---------------- UI construction ----------------
    def initUI(self):
        self.setStyleSheet((ASSETS / "style.qss").read_text())
        self.setWindowTitle("PixelStreamer")
        self.setWindowIcon(QIcon(str(ASSETS / "icon.png")))
        self.setGeometry(100, 100, 256, 160)
        self._font = QFont("Courier New")

        central_widget = QWidget()
        main_layout = QHBoxLayout()
        central_widget.setLayout(main_layout)
        self.setCentralWidget(central_widget)

        sidebar = QWidget()
        sidebar_layout = QVBoxLayout()
        sidebar_layout.setContentsMargins(20, 40, 20, 20)
        sidebar_layout.setSpacing(30)
        sidebar_layout.setAlignment(Qt.AlignHCenter)
        sidebar.setLayout(sidebar_layout)

        title = QLabel("PixelStreamer")
        title.setFont(self._font)
        title.setObjectName("titleLabel")
        sidebar_layout.addWidget(title)

        def make_button(label, handler, checkable=False):
            button = QPushButton(label)
            button.setFont(self._font)
            button.setCursor(Qt.PointingHandCursor)
            button.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            if checkable:
                button.setCheckable(True)
                button.setChecked(True)
                button.setEnabled(False)
                button.toggled.connect(handler)
            else:
                button.clicked.connect(handler)
            sidebar_layout.addWidget(button)
            return button

        self.code_button = make_button("Generate Code", self.on_code_button)
        self.tray_button = make_button("Hide Into Tray", self.hide_to_tray)
        self.cam_button = make_button("Webcam", self.on_cam_toggled, checkable=True)
        self.mic_button = make_button("Microphone", self.on_mic_toggled, checkable=True)

        self.connection_status = QLabel("Connection: Not Connected")
        self.connection_status.setFont(self._font)
        self.connection_status.setObjectName("connectionStatus")
        self.connection_status.setWordWrap(True)
        sidebar_layout.addWidget(self.connection_status)

        sidebar_layout.addSpacerItem(
            QSpacerItem(20, 40, QSizePolicy.Minimum, QSizePolicy.Expanding)
        )

        preview_container = QVBoxLayout()
        preview_container.setContentsMargins(20, 40, 40, 40)
        preview_container.setSpacing(20)

        preview_label = QLabel("Preview")
        preview_label.setFont(self._font)
        preview_label.setAlignment(Qt.AlignLeft)
        preview_label.setObjectName("previewLabel")

        self.preview_frame = QWidget()
        self.preview_frame.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.preview_frame.setObjectName("previewFrame")
        preview_label.setBuddy(self.preview_frame)

        self.video_label = QLabel()
        self.video_label.setAlignment(Qt.AlignCenter)
        self.video_label.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Ignored)

        preview_layout = QVBoxLayout()
        preview_layout.addWidget(self.video_label)
        self.preview_frame.setLayout(preview_layout)

        preview_container.addWidget(preview_label)
        preview_container.addWidget(self.preview_frame)

        main_layout.addWidget(sidebar)
        main_layout.addLayout(preview_container)

        self.create_tray_icon()

    def create_tray_icon(self):
        self.tray_icon = QSystemTrayIcon(self)
        self.tray_icon.setIcon(QIcon(str(ASSETS / "icon.png")))

        tray_menu = QMenu(self)
        self.tray_action_code = tray_menu.addAction("Generate Code")
        self.tray_action_code.triggered.connect(self.on_code_button)
        tray_menu.addSeparator()

        self.tray_action_cam = tray_menu.addAction("Webcam")
        self.tray_action_cam.setCheckable(True)
        self.tray_action_cam.toggled.connect(self.cam_button.setChecked)

        self.tray_action_mic = tray_menu.addAction("Microphone")
        self.tray_action_mic.setCheckable(True)
        self.tray_action_mic.toggled.connect(self.mic_button.setChecked)
        tray_menu.addSeparator()

        tray_menu.addAction("Show", self.show_main_window)
        tray_menu.addAction("Quit", self.handle_quit)

        self.tray_icon.setContextMenu(tray_menu)
        self.tray_icon.activated.connect(self.on_tray_activated)
        self.tray_icon.show()
        self.sync_tray_state()

    # ---------------- tray / window ----------------
    def on_tray_activated(self, reason):
        if reason == QSystemTrayIcon.Trigger:
            self.show_main_window()

    def show_main_window(self):
        self.show()
        self.raise_()
        self.activateWindow()

    def hide_to_tray(self):
        self.sync_tray_state()
        self.hide()
        msg = f"Running in tray. Code: {self.code}" if self.code else "Running in tray."
        self.tray_icon.showMessage("PixelStreamer", msg, QSystemTrayIcon.Information, 2000)

    def sync_tray_state(self):
        self.tray_action_code.setText(self.code_button.text())
        self.tray_action_code.setEnabled(self.code_button.isEnabled())
        for action, button in ((self.tray_action_cam, self.cam_button),
                               (self.tray_action_mic, self.mic_button)):
            action.blockSignals(True)
            action.setChecked(button.isChecked())
            action.setEnabled(button.isEnabled())
            action.blockSignals(False)

    def set_status(self, text, color=None):
        self.connection_status.setText(text)
        self.connection_status.setStyleSheet(f"color: {color}" if color else "")

    # ---------------- code lifecycle ----------------
    def on_code_button(self):
        if self.code:
            self.end_session()
            return
        if not self.code_button.isEnabled():
            return
        self.code_button.setText("Generating...")
        self.code_button.setEnabled(False)
        self.sync_tray_state()

        def work():
            try:
                self._bridge.code_ready.emit(api.generate_code())
            except Exception as e:
                print(f"Failed to generate code: {e!r}")
                self._bridge.code_failed.emit(str(e))

        threading.Thread(target=work, daemon=True).start()

    @Slot(str)
    def on_code_ready(self, code):
        self.code = code
        self.code_button.setText(code)
        self.code_button.setEnabled(True)
        self.code_button.setToolTip("Click to cancel this code")

        worker = WebRTCWorker(code=code, cam=self.cam, mic=self.mic)
        # Bind every signal to this worker instance so late signals from an
        # old session can never affect a newer one.
        worker.state_changed.connect(lambda s, w=worker: self.on_connection_state(w, s))
        worker.failed.connect(lambda msg, w=worker: self.on_session_failed(w, msg))
        worker.remote_toggle.connect(lambda d, v, w=worker: self.on_remote_toggle(w, d, v))
        self.worker = worker
        worker.start()
        self.sync_tray_state()

    @Slot(str)
    def on_code_failed(self, _msg):
        self.code_button.setText("Generate Code")
        self.code_button.setEnabled(True)
        self.set_status("Could not reach server. Check your connection and retry.", "#E74C3C")
        self.sync_tray_state()

    def end_session(self, status_text="Connection: Not Connected", color=None):
        """Stop the current worker, delete its code, and reset the UI."""
        worker, self.worker = self.worker, None
        code, self.code = self.code, None
        if worker:
            worker.stop()
        if code:
            threading.Thread(target=self._delete_code_quietly, args=(code,), daemon=True).start()

        self.code_button.setText("Generate Code")
        self.code_button.setEnabled(True)
        self.code_button.setToolTip("")
        for button in (self.cam_button, self.mic_button):
            button.blockSignals(True)
            button.setChecked(True)
            button.setEnabled(False)
            button.blockSignals(False)
        self.video_label.clear()
        self._preview_image = None
        self.set_status(status_text, color)
        self.sync_tray_state()

    @staticmethod
    def _delete_code_quietly(code, quick=False):
        try:
            api.delete_code(code, attempts=1 if quick else 3)
        except Exception as e:
            print(f"Failed to delete code {code}: {e!r}")

    # ---------------- worker signals ----------------
    def on_connection_state(self, worker, state):
        if worker is not self.worker:
            return
        color = self.STATUS_COLORS[state]
        if state == ConnectionState.DISCONNECTED:
            self.end_session("Connection: Disconnected", color)
            return
        if state == ConnectionState.FAILED:
            return  # on_session_failed carries the reason and resets the UI
        if state == ConnectionState.CONNECTED:
            self.cam_button.setEnabled(True)
            self.mic_button.setEnabled(True)
            self.sync_tray_state()
        self.set_status(f"Connection: {state.value.capitalize()}", color)

    def on_session_failed(self, worker, message):
        if worker is not self.worker:
            return
        self.end_session(f"Connection failed: {message}", self.STATUS_COLORS[ConnectionState.FAILED])

    def on_remote_toggle(self, worker, device, value):
        if worker is not self.worker:
            return
        on = value == "on"
        targets = {"mic": [self.mic_button], "cam": [self.cam_button],
                   "media": [self.mic_button, self.cam_button]}[device]
        for button in targets:
            # The phone already applied this change; don't echo it back.
            button.blockSignals(True)
            button.setChecked(on)
            button.blockSignals(False)
        self.sync_tray_state()

    def on_cam_toggled(self, checked):
        if self.worker:
            self.worker.toggle_cam(checked)
        self.sync_tray_state()

    def on_mic_toggled(self, checked):
        if self.worker:
            self.worker.toggle_mic(checked)
        self.sync_tray_state()

    # ---------------- preview ----------------
    @Slot(object)
    def on_preview(self, rgb):
        if rgb is None or not self.worker:
            self.video_label.clear()
            self._preview_image = None
            return
        rgb = np.ascontiguousarray(rgb)
        h, w, _ = rgb.shape
        self._preview_image = QImage(rgb.data, w, h, 3 * w, QImage.Format_RGB888).copy()
        self._render_preview()

    def _render_preview(self):
        if self._preview_image is None:
            return
        self.video_label.setPixmap(QPixmap.fromImage(self._preview_image).scaled(
            self.video_label.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._render_preview()

    # ---------------- exit ----------------
    def shutdown(self):
        """Idempotent: runs from closeEvent, Quit, aboutToQuit or SIGINT."""
        if self._shut_down:
            return
        self._shut_down = True
        worker, self.worker = self.worker, None
        if worker:
            worker.stop(wait=True, timeout=2)
        if self.code:
            self._delete_code_quietly(self.code, quick=True)
            self.code = None
        self.cam.stop()
        self.mic.stop()
        self.cam.join(2)
        self.mic.join(3)  # removes the PipeWire virtual mic modules
        self.tray_icon.hide()

    def handle_quit(self):
        self.shutdown()
        QApplication.quit()

    def closeEvent(self, event):
        self.shutdown()
        event.accept()
        QApplication.quit()
