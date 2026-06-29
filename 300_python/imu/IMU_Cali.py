#!/usr/bin/env python3

import argparse
import math
import time

from IMU import IMU


def format_vec(name, values, unit):
    return f"{name}: X={values[0]: .4f}{unit}, Y={values[1]: .4f}{unit}, Z={values[2]: .4f}{unit}"


def calc_pitch_roll(ax, ay, az):
    pitch = math.degrees(math.atan2(-ax, math.sqrt((ay * ay) + (az * az))))
    roll = math.degrees(math.atan2(ay, az))
    return pitch, roll


def print_raw_and_cali_sample(imu, title):
    pitch_raw, roll_raw, ax_raw, ay_raw, az_raw, gx_raw, gy_raw, gz_raw = imu.read()
    ax_c, ay_c, az_c, gx_c, gy_c, gz_c = imu.apply_leveling(ax_raw, ay_raw, az_raw, gx_raw, gy_raw, gz_raw)
    pitch_cali, roll_cali = calc_pitch_roll(ax_c, ay_c, az_c)
    if title:
        print(title)
    print(f"RAW  pitch={pitch_raw:7.2f} deg, roll={roll_raw:7.2f} deg | ACC=({ax_raw:7.3f}, {ay_raw:7.3f}, {az_raw:7.3f}) g | GYR=({gx_raw:7.3f}, {gy_raw:7.3f}, {gz_raw:7.3f}) dps")
    print(f"CALI pitch={pitch_cali:7.2f} deg, roll={roll_cali:7.2f} deg | ACC=({ax_c:7.3f}, {ay_c:7.3f}, {az_c:7.3f}) g | GYR=({gx_c:7.3f}, {gy_c:7.3f}, {gz_c:7.3f}) dps")


def make_progress_printer(imu, interval_sec=0.2):
    last_print_time = [0.0]

    def progress_callback(sample_count, elapsed_sec, raw_values, cali_values):
        if elapsed_sec - last_print_time[0] < interval_sec and sample_count != 1:
            return
        last_print_time[0] = elapsed_sec
        ax_raw, ay_raw, az_raw, gx_raw, gy_raw, gz_raw = raw_values
        ax_c, ay_c, az_c, gx_c, gy_c, gz_c = cali_values
        pitch_raw, roll_raw = calc_pitch_roll(ax_raw, ay_raw, az_raw)
        pitch_cali, roll_cali = calc_pitch_roll(ax_c, ay_c, az_c)
        print(f"[{elapsed_sec:5.1f}s] RAW  pitch={pitch_raw:7.2f} deg, roll={roll_raw:7.2f} deg | ACC=({ax_raw:7.3f}, {ay_raw:7.3f}, {az_raw:7.3f}) g | GYR=({gx_raw:7.3f}, {gy_raw:7.3f}, {gz_raw:7.3f}) dps")
        print(f"[{elapsed_sec:5.1f}s] CALI pitch={pitch_cali:7.2f} deg, roll={roll_cali:7.2f} deg | ACC=({ax_c:7.3f}, {ay_c:7.3f}, {az_c:7.3f}) g | GYR=({gx_c:7.3f}, {gy_c:7.3f}, {gz_c:7.3f}) dps")

    return progress_callback


def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="IMU.py를 사용한 수평 캘리브레이션 도구"
    )
    parser.add_argument("--delay", type=float, default=0.02, help="샘플 간 지연 시간(초)")
    return parser


def main():
    args = build_arg_parser().parse_args()
    imu = IMU(skip_calibration=False)
    monitor = True

    print("수평 캘리브레이션을 시작합니다.")
    print("센서를 가능한 한 수평으로 놓고 움직이지 마세요.")
    print(f"캘리브레이션 시간: 10.000s, 샘플 간 지연: {args.delay:.3f}s")

    try:
        print("캘리브레이션 중 출력은 RAW와 CALI를 함께 표시합니다.")
        result = imu.calibrate_level(duration_sec=10.0, delay=args.delay, progress_callback=make_progress_printer(imu))
        cali_path = imu.save_calibration()

        print()
        print("캘리브레이션 완료")
        print(f"캘리브레이션 샘플 수: {result['sample_count']}")
        print(format_vec("Accel baseline", result["accel_baseline"], " g"))
        print(format_vec("Accel ref 1g", result["accel_ref_1g"], " g"))
        print(format_vec("Gyro baseline", result["gyro_baseline"], " dps"))
        print(f"저장 파일: {cali_path}")
        print()
        print_raw_and_cali_sample(imu, "캘리브레이션된 현재 값")

        if monitor:
            print()
            print("캘리브레이션된 데이터 출력 중입니다. Ctrl+C로 종료하세요.")
            while True:
                print_raw_and_cali_sample(imu, "")
                time.sleep(0.2)
    except KeyboardInterrupt:
        print("\n중단되었습니다.")
    finally:
        imu.close()


if __name__ == "__main__":
    main()