from gpiozero import TonalBuzzer
from gpiozero.tones import Tone

buzzer = TonalBuzzer(4)

print("Playing tone A4...")

buzzer.play(Tone("A3"))

# 사용자 입력을 기다림으로써 프로그램이 종료되지 않도록 함
input("Enter to quit! ")