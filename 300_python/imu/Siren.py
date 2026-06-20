from gpiozero import TonalBuzzer
from gpiozero.tones import Tone
from time import sleep

buzzer = TonalBuzzer(4)

for _ in range(10):
    print("Playing tones A4 and A5")
    
    buzzer.play(Tone("A4"))
    sleep(0.2)

    buzzer.play(Tone("A5"))
    sleep(0.2)

buzzer.stop()