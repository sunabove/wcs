from enum import IntEnum

class GpioNo(IntEnum):
    # I2C
    SDA = 2
    SCL = 3

    # Buzzer
    BUZZER = 4

    # Encoder
    ENCODER_FR = 23
    ENCODER_FL = 24
    ENCODER_RR = 25
    ENCODER_RL = 12

    # Motor 1
    STBY1 = 19
    
    MOTOR_FR_IN1 = 10
    MOTOR_FR_IN2 = 9
    MOTOR_FR_PWM = 11
    
    MOTOR_FL_IN1 = 14
    MOTOR_FL_IN2 = 15
    MOTOR_FL_PWM = 18
    
    # Motor 2
    STBY2 = 26
    
    MOTOR_RR_IN1 = 17
    MOTOR_RR_IN2 = 27
    MOTOR_RR_PWM = 22
    
    MOTOR_RL_IN1 = 16
    MOTOR_RL_IN2 = 20
    MOTOR_RL_PWM = 21
pass