import RPi.GPIO as GPIO
import time


class SystemSound:
    """Buzzer sound controller for system notifications"""
    
    def __init__(self, buzzer_pin=4, base_freq=440):
        """
        Initialize SystemSound controller
        
        Args:
            buzzer_pin (int): GPIO pin for buzzer (default: 4)
            base_freq (int): Base frequency for PWM (default: 440)
        """
        self.buzzer_pin = buzzer_pin
        self.base_freq = base_freq
        
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(self.buzzer_pin, GPIO.OUT)
        
        self.pwm = GPIO.PWM(self.buzzer_pin, self.base_freq)
        self.pwm.start(0)
    
    def note(self, freq, duration, duty=50):
        """
        Play a single note
        
        Args:
            freq (float): Frequency in Hz
            duration (float): Duration in seconds
            duty (int): Duty cycle percentage (default: 50)
        """
        self.pwm.ChangeFrequency(freq)
        self.pwm.ChangeDutyCycle(duty)
        time.sleep(duration)
        self.pwm.ChangeDutyCycle(0)
        time.sleep(0.02)
    
    # --------------------------------------------------
    # PX4 Startup Tune
    # --------------------------------------------------
    def startup_tune(self):
        """Play startup tune"""
        self.note(523, 0.10)   # C5
        self.note(659, 0.10)   # E5
        self.note(784, 0.15)   # G5
    
    # --------------------------------------------------
    # Positive Notification
    # --------------------------------------------------
    def positive_tune(self):
        """Play positive notification tune"""
        self.note(523, 0.08)
        self.note(659, 0.08)
        self.note(784, 0.12)
    
    # --------------------------------------------------
    # Neutral Notification
    # --------------------------------------------------
    def neutral_tune(self):
        """Play neutral notification tune"""
        self.note(659, 0.10)
        self.note(659, 0.10)
    
    # --------------------------------------------------
    # Negative Notification
    # --------------------------------------------------
    def negative_tune(self):
        """Play negative notification tune"""
        self.note(784, 0.08)
        self.note(659, 0.08)
        self.note(523, 0.15)
    
    # --------------------------------------------------
    # Arming Warning
    # --------------------------------------------------
    def arming_tune(self):
        """Play arming warning tune"""
        self.note(880, 0.10)
        self.note(880, 0.10)
        self.note(880, 0.10)
    
    # --------------------------------------------------
    # Arming Failure
    # --------------------------------------------------
    def arming_failure(self):
        """Play arming failure tune"""
        self.note(523, 0.20)
        self.note(440, 0.20)
        self.note(349, 0.30)
    
    # --------------------------------------------------
    # Battery Warning
    # --------------------------------------------------
    def battery_warning(self):
        """Play battery warning tune"""
        for _ in range(3):
            self.note(880, 0.15)
            time.sleep(0.15)
    
    # --------------------------------------------------
    # Critical Battery
    # --------------------------------------------------
    def battery_critical(self):
        """Play critical battery tune"""
        for _ in range(6):
            self.note(1200, 0.08)
            time.sleep(0.05)
    
    # --------------------------------------------------
    # GPS Warning
    # --------------------------------------------------
    def gps_warning(self):
        """Play GPS warning tune"""
        for _ in range(4):
            self.note(700, 0.05)
            time.sleep(0.20)
    
    # --------------------------------------------------
    # Single Beep
    # --------------------------------------------------
    def single_beep(self):
        """Play single beep"""
        self.note(1000, 0.10)
    
    def cleanup(self):
        """Clean up GPIO resources"""
        if self.pwm:
            self.pwm.stop()
        GPIO.cleanup()
    
    def __del__(self):
        """Destructor to ensure cleanup"""
        try:
            self.cleanup()
        except:
            pass


if __name__ == "__main__":
    sound = SystemSound()
    
    try:
        print("startup")
        sound.startup_tune()
        time.sleep(1)

        print("positive")
        sound.positive_tune()
        time.sleep(1)

        print("negative")
        sound.negative_tune()
        time.sleep(1)

        print("arming")
        sound.arming_tune()
        time.sleep(1)

        print("battery")
        sound.battery_warning()

    finally:
        sound.cleanup()
        # 사용자 입력을 기다림으로써 프로그램이 종료되지 않도록 함
        input("Enter to quit! ")