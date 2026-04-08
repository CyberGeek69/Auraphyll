import subprocess
import sys
import os

def install_requirements():
    print("🚀 Checking and installing dependencies...")
    try:
        # Runs the pip install command pointing to the requirements file
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "backend/requirements.txt"])
        print("✅ All requirements installed successfully.\n")
    except Exception as e:
        print(f"❌ Error installing requirements: {e}")
        sys.exit(1)

def start_server():
    print("🌍 Starting Auraphyll Backend Server...")
    # Change directory to backend to ensure main:app is found
    os.chdir("backend")
    try:
        # Runs the uvicorn command
        subprocess.run([sys.executable, "-m", "uvicorn", "main:app", "--reload"])
    except KeyboardInterrupt:
        print("\n🛑 Server stopped by user.")
    except Exception as e:
        print(f"❌ Failed to start server: {e}")

if __name__ == "__main__":
    install_requirements()
    start_server()