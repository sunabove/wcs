import argparse

from IMU import IMU_MPU9250


def build_arg_parser():
	parser = argparse.ArgumentParser(
		description="IMU.py 기반 수평 캘리브레이션 후 IMU_Cali.txt 저장"
	)
	parser.add_argument("--duration", type=float, default=10.0, help="캘리브레이션 시간(초)")
	parser.add_argument("--sample-delay", type=float, default=0.02, help="샘플 간 지연(초)")
	return parser


def main():
	args = build_arg_parser().parse_args()

	imu = IMU_MPU9250(
		calib_duration_sec=args.duration,
		calib_delay=args.sample_delay,
	)

	try:
		imu.initialize_sensor()
		imu.calibrate() 
	except KeyboardInterrupt:
		print("\nCalibration canceled by user.")
	except Exception as e:
		print(f"Calibration failed: {e}")


if __name__ == "__main__":
	main()
