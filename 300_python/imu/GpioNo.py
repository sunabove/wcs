from enum import IntEnum

class GpioNo(IntEnum):
    # I2C
    SDA = 2
    SCL = 3

    # Buzzer
    BUZZER = 4

    # Encoder
    ENCODER_FR = 25
    ENCODER_FL = 8
    ENCODER_RR = 7
    ENCODER_RL = 1

    # Motor
    STBY1 = 19
    MOTOR_FR = 10,9,11
    MOTOR_FL = 14,15,16
    STBY2 = 26
    MOTOR_RR = 17,27,22
    MOTOR_RL = 16,20,21
pass