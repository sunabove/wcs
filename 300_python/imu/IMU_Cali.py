#!/usr/bin/env python3

import argparse
import math
import os
import time

from IMU import IMU


def mean(values):
	return sum(values) / len(values) if values else 0.0


def stddev(values, avg):
	if not values:
		return 0.0
	return math.sqrt(sum((v - avg) * (v - avg) for v in values) / len(values))


def calc_pitch_roll(ax, ay, az):
	pitch = math.degrees(math.atan2(-ax, math.sqrt(ay * ay + az * az)))
	roll = math.degrees(math.atan2(ay, az))
	return pitch, roll


def normalize_yaw(yaw):
	while yaw > 180.0:
		yaw -= 360.0
	while yaw < -180.0:
		yaw += 360.0
	return yaw


def main():
	parser = argparse.ArgumentParser(description="IMU 10-second level calibration")
	parser.add_argument("--seconds", type=float, default=10.0, help="Calibration duration in seconds")
	parser.add_argument("--dt", type=float, default=0.02, help="Sample interval in seconds")
	args = parser.parse_args()

	imu = IMU(skip_calibration=True)
	ax_list, ay_list, az_list = [], [], []
	gx_list, gy_list, gz_list = [], [], []
	mx_list, my_list, mz_list = [], [], []
	pitch_list, roll_list = [], []
	ax_sum = ay_sum = az_sum = 0.0
	gx_sum = gy_sum = gz_sum = 0.0
	mx_min = my_min = mz_min = float("inf")
	mx_max = my_max = mz_max = float("-inf")
	sample_count = 0

	start = time.monotonic()
	end_time = start + args.seconds
	prev_time = start
	raw_yaw = 0.0
	cal_yaw = 0.0
	print(f"Start calibration: keep IMU level/still and slowly rotate for AK8963 for {args.seconds:.2f}s")

	try:
		while time.monotonic() < end_time:
			pitch, roll, ax, ay, az, gx, gy, gz = imu.read()
			mx, my, mz = imu.read_mag()
			now = time.monotonic()
			dt = max(0.0, now - prev_time)
			prev_time = now
			pitch_list.append(pitch)
			roll_list.append(roll)
			ax_list.append(ax)
			ay_list.append(ay)
			az_list.append(az)
			gx_list.append(gx)
			gy_list.append(gy)
			gz_list.append(gz)
			mx_list.append(mx)
			my_list.append(my)
			mz_list.append(mz)
			mx_min = min(mx_min, mx)
			my_min = min(my_min, my)
			mz_min = min(mz_min, mz)
			mx_max = max(mx_max, mx)
			my_max = max(my_max, my)
			mz_max = max(mz_max, mz)
			ax_sum += ax
			ay_sum += ay
			az_sum += az
			gx_sum += gx
			gy_sum += gy
			gz_sum += gz
			sample_count += 1

			curr_ax_offset = -(ax_sum / sample_count)
			curr_ay_offset = -(ay_sum / sample_count)
			curr_az_offset = 1.0 - (az_sum / sample_count)
			curr_gx_offset = -(gx_sum / sample_count)
			curr_gy_offset = -(gy_sum / sample_count)
			curr_gz_offset = -(gz_sum / sample_count)
			curr_mx_offset = -((mx_min + mx_max) * 0.5)
			curr_my_offset = -((my_min + my_max) * 0.5)
			curr_mz_offset = -((mz_min + mz_max) * 0.5)

			cal_ax = ax + curr_ax_offset
			cal_ay = ay + curr_ay_offset
			cal_az = az + curr_az_offset
			cal_gx = gx + curr_gx_offset
			cal_gy = gy + curr_gy_offset
			cal_gz = gz + curr_gz_offset
			cal_mx = mx + curr_mx_offset
			cal_my = my + curr_my_offset
			cal_mz = mz + curr_mz_offset

			cal_pitch, cal_roll = calc_pitch_roll(cal_ax, cal_ay, cal_az)
			raw_yaw = normalize_yaw(raw_yaw + gz * dt)
			cal_yaw = normalize_yaw(cal_yaw + cal_gz * dt)
			raw_mag_yaw = normalize_yaw(math.degrees(math.atan2(my, mx)))
			cal_mag_yaw = normalize_yaw(math.degrees(math.atan2(cal_my, cal_mx)))

			remain = max(0.0, end_time - time.monotonic())
			print(
				f"[{sample_count:3d}] {remain:5.2f}s "
				f"raw_rpy=({roll:+.2f},{pitch:+.2f},{raw_yaw:+.2f}) "
				f"cal_rpy=({cal_roll:+.2f},{cal_pitch:+.2f},{cal_yaw:+.2f}) "
				f"acc_off=({curr_ax_offset:+.2f},{curr_ay_offset:+.2f},{curr_az_offset:+.2f}) "
				f"gyr_off=({curr_gx_offset:+.2f},{curr_gy_offset:+.2f},{curr_gz_offset:+.2f}) "
				f"mag_off=({curr_mx_offset:+.2f},{curr_my_offset:+.2f},{curr_mz_offset:+.2f}) "
				f"raw_acc=({ax:+.2f},{ay:+.2f},{az:+.2f}) "
				f"cal_acc=({cal_ax:+.2f},{cal_ay:+.2f},{cal_az:+.2f}) "
				f"raw_gyr=({gx:+.2f},{gy:+.2f},{gz:+.2f}) "
				f"cal_gyr=({cal_gx:+.2f},{cal_gy:+.2f},{cal_gz:+.2f}) "
				f"raw_mag=({mx:+.1f},{my:+.1f},{mz:+.1f}) "
				f"cal_mag=({cal_mx:+.1f},{cal_my:+.1f},{cal_mz:+.1f}) "
				f"mag_yaw=({raw_mag_yaw:+.1f}->{cal_mag_yaw:+.1f})"
			)
			time.sleep(args.dt)
	except KeyboardInterrupt:
		print("Calibration interrupted by user.")
	finally:
		imu.close()

	n = len(ax_list)
	if n == 0:
		raise SystemExit("No samples collected; calibration file was not created.")

	ax_avg, ay_avg, az_avg = mean(ax_list), mean(ay_list), mean(az_list)
	gx_avg, gy_avg, gz_avg = mean(gx_list), mean(gy_list), mean(gz_list)
	mx_avg, my_avg, mz_avg = mean(mx_list), mean(my_list), mean(mz_list)
	pitch_avg, roll_avg = mean(pitch_list), mean(roll_list)

	accel_norm_avg = mean([math.sqrt(ax * ax + ay * ay + az * az) for ax, ay, az in zip(ax_list, ay_list, az_list)])

	# Level-still baseline offsets (target: ax=0g, ay=0g, az=+1g, gyro=0dps)
	ax_offset = -ax_avg
	ay_offset = -ay_avg
	az_offset = 1.0 - az_avg
	gx_offset = -gx_avg
	gy_offset = -gy_avg
	gz_offset = -gz_avg
	mx_offset = -((mx_min + mx_max) * 0.5)
	my_offset = -((my_min + my_max) * 0.5)
	mz_offset = -((mz_min + mz_max) * 0.5)

	folder = os.path.dirname(os.path.abspath(__file__))
	out_path = os.path.join(folder, "IMU_cali.txt")

	lines = [
		"# IMU calibration generated by IMU_Cali.py",
		f"timestamp_unix={int(time.time())}",
		f"duration_sec={args.seconds}",
		f"sample_interval_sec={args.dt}",
		f"sample_count={n}",
		f"pitch_avg_deg={pitch_avg:.6f}",
		f"roll_avg_deg={roll_avg:.6f}",
		f"ax_avg_g={ax_avg:.6f}",
		f"ay_avg_g={ay_avg:.6f}",
		f"az_avg_g={az_avg:.6f}",
		f"gx_avg_dps={gx_avg:.6f}",
		f"gy_avg_dps={gy_avg:.6f}",
		f"gz_avg_dps={gz_avg:.6f}",
		f"mx_avg_ut={mx_avg:.6f}",
		f"my_avg_ut={my_avg:.6f}",
		f"mz_avg_ut={mz_avg:.6f}",
		f"mx_min_ut={mx_min:.6f}",
		f"my_min_ut={my_min:.6f}",
		f"mz_min_ut={mz_min:.6f}",
		f"mx_max_ut={mx_max:.6f}",
		f"my_max_ut={my_max:.6f}",
		f"mz_max_ut={mz_max:.6f}",
		f"accel_norm_avg_g={accel_norm_avg:.6f}",
		f"ax_offset_g={ax_offset:.6f}",
		f"ay_offset_g={ay_offset:.6f}",
		f"az_offset_g={az_offset:.6f}",
		f"gx_offset_dps={gx_offset:.6f}",
		f"gy_offset_dps={gy_offset:.6f}",
		f"gz_offset_dps={gz_offset:.6f}",
		f"mx_offset_ut={mx_offset:.6f}",
		f"my_offset_ut={my_offset:.6f}",
		f"mz_offset_ut={mz_offset:.6f}",
		f"gz_stddev_dps={stddev(gz_list, gz_avg):.6f}",
	]

	with open(out_path, "w", encoding="utf-8") as fp:
		fp.write("\n".join(lines) + "\n")

	print(f"Calibration done. samples={n}")
	print(
		f"Final accel offset(g): "
		f"ax={ax_offset:+.2f}, ay={ay_offset:+.2f}, az={az_offset:+.2f}"
	)
	print(
		f"Final gyro offset(dps): "
		f"gx={gx_offset:+.2f}, gy={gy_offset:+.2f}, gz={gz_offset:+.2f}"
	)
	print(
		f"Final mag offset(uT): "
		f"mx={mx_offset:+.2f}, my={my_offset:+.2f}, mz={mz_offset:+.2f}"
	)
	print(f"Saved: {out_path}")


if __name__ == "__main__":
	main()
