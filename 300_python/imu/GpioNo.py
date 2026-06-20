from enum import IntEnum

class GpioNo(IntEnum):
    # I2C
    SDA = 2
    SCL = 3

    # Buzzer
    BUZZER = 4

    # Encoder
    ENCODER_FR = 20
    ENCODER_FL = 21
    ENCODER_RR = 14
    ENCODER_RL = 15

    # Motor
    MOTOR_FR = 12
    MOTOR_FL = 16
    MOTOR_RR = 23
    MOTOR_RL = 24
pass