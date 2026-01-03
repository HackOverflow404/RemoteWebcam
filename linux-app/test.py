import time
import struct
import math

# Audio configuration (must match the pactl command in Step 1)
RATE = 44100
CHANNELS = 2
FORMAT = 's16le' # Signed 16-bit little-endian

def write_audio_to_pipe(pipe_path, duration_seconds=500):
    """Generates a simple sine wave and writes it to a named pipe."""
    print(f"Opening pipe {pipe_path} for writing...")
    with open(pipe_path, 'wb') as f:
        print("Pipe opened. Writing audio data...")
        # Generate a 440 Hz sine wave
        for i in range(0, int(RATE * duration_seconds)):
            value = math.sin(i / RATE * 440 * 2 * math.pi) * 32767
            # Pack as a signed 16-bit integer (little-endian)
            # Write the same value to both channels for stereo
            packed_value = struct.pack('<h', int(value))
            f.write(packed_value)
            f.write(packed_value) # Write for the second channel
        print("Finished writing audio data.")

if __name__ == "__main__":
    PIPE_PATH = "/tmp/pixel_streamer_audio_fifo"
    write_audio_to_pipe(PIPE_PATH)
