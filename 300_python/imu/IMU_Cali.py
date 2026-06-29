#!/usr/bin/env python3

import argparse
import time

from IMU import IMU


def format_vec(name, values, unit):
    return f"{name}: X={values[0]: .4f}{unit}, Y={values[1]: .4f}{unit}, Z={values[2]: .4f}{unit}"


def print_leveled_sample(imu, title):
    pitch, roll, ax, ay, az, gx, gy, gz = imu.read_leveled()
    if title:
        print(title)
    print(
        f"pitch={pitch:7.2f} deg, roll={roll:7.2f} deg | "
        f"ACC=({ax:7.3f}, {ay:7.3f}, {az:7.3f}) g | "
        f"GYR=({gx:7.3f}, {gy:7.3f}, {gz:7.3f}) dps"
    )


def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="IMU.py를 사용한 수평 캘리브레이션 도구"
    )
    parser.add_argument("--samples", type=int, default=50, help="캘리브레이션 샘플 수")
    parser.add_argument("--delay", type=float, default=0.02, help="샘플 간 지연 시간(초)")
    return parser


def main():
    args = build_arg_parser().parse_args()
    imu = IMU(skip_calibration=False)
    monitor = True

    print("수평 캘리브레이션을 시작합니다.")
    print("센서를 가능한 한 수평으로 놓고 움직이지 마세요.")
    print(f"샘플 수: {args.samples}, 샘플 간 지연: {args.delay:.3f}s")

    try:
        result = imu.calibrate_level(samples=args.samples, delay=args.delay)
        cali_path = imu.save_calibration()

        print()
        print("캘리브레이션 완료")
        print(format_vec("Accel baseline", result["accel_baseline"], " g"))
        print(format_vec("Accel ref 1g", result["accel_ref_1g"], " g"))
        print(format_vec("Gyro baseline", result["gyro_baseline"], " dps"))
        print(f"저장 파일: {cali_path}")
        print()
        print_leveled_sample(imu, "캘리브레이션된 현재 값")

        if monitor:
            print()
            print("캘리브레이션된 데이터 출력 중입니다. Ctrl+C로 종료하세요.")
            while True:
                print_leveled_sample(imu, "")
                time.sleep(0.2)
    except KeyboardInterrupt:
        print("\n중단되었습니다.")
    finally:
        imu.close()


if __name__ == "__main__":
    main()