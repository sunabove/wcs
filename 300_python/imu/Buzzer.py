# gpiozero 패키지 Buzzer 클래스 임포트
from gpiozero import Buzzer
# time 모듈에서 sleep 함수를 임포트하여 시간 지연 사용
from time import sleep
# Buzzer 객체 생성, GPIO 4번 핀에 연결된 부저를 제어
buzzer = Buzzer(4)
# 부저 비프음 설정
# on_time: 부저가 켜져 있는 시간 (초 단위) # off_time: 부저가 꺼져 있는 시간 (초 단위)
# n: 비프음의 반복 횟수
print("Beep! Beep! Beep!")

buzzer.beep(on_time=1, off_time=0.5, n=4)

# 사용자 입력을 기다림으로써 프로그램이 종료되지 않도록 함
input("Enter to quit! ")