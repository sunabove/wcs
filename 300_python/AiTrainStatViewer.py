from pathlib import Path
import os

os.environ.setdefault("MPLBACKEND", "Agg")

import matplotlib.pyplot as plt
import pandas as pd


class AiTrainStatViewer:
	def __init__(self, script_dir: Path | None = None):
		self.script_dir = script_dir or Path(__file__).resolve().parent

	@staticmethod
	def normalize_columns(dataframe: pd.DataFrame) -> pd.DataFrame:
		dataframe = dataframe.copy()
		dataframe.columns = [str(column).strip() for column in dataframe.columns]
		return dataframe

	def candidate_run_roots(self) -> list[Path]:
		candidates = [
			self.script_dir / "ai" / "road" / "runs" / "segment",
			self.script_dir / "ai" / "road" / "road" / "runs",
			self.script_dir / "ai" / "road" / "runs" / "segment" / "road" / "runs",
		]

		unique_candidates = []
		seen = set()
		for candidate in candidates:
			resolved = candidate.resolve()
			if resolved in seen:
				continue
			seen.add(resolved)
			unique_candidates.append(candidate)
		return unique_candidates

	def discover_run_folders(self) -> list[Path]:
		run_folders = []
		seen = set()

		for root in self.candidate_run_roots():
			if not root.exists() or not root.is_dir():
				continue

			for child in sorted(root.iterdir(), key=lambda path: path.name.lower()):
				if not child.is_dir():
					continue

				results_csv = child / "results.csv"
				if not results_csv.exists():
					continue

				resolved = child.resolve()
				if resolved in seen:
					continue

				seen.add(resolved)
				run_folders.append(child)

		return run_folders

	def select_run_folder(self, run_folders: list[Path]) -> Path:
		if not run_folders:
			raise FileNotFoundError(
				"No run folders with results.csv were found under: runs/segment, road/runs, runs/segment/road/runs"
			)

		print("Available training run folders:")
		for index, folder in enumerate(run_folders, start=1):
			print(f"  {index}. {folder}")

		while True:
			raw = input("Select folder number: ").strip()
			try:
				selected_index = int(raw)
			except ValueError:
				print("Please enter a valid number.")
				continue

			if 1 <= selected_index <= len(run_folders):
				return run_folders[selected_index - 1]

			print(f"Please select a number between 1 and {len(run_folders)}.")

	@staticmethod
	def available_metric_columns(dataframe: pd.DataFrame, preferred_columns: list[str]) -> list[str]:
		return [column for column in preferred_columns if column in dataframe.columns]

	def plot_training_progress(self, run_folder: Path) -> None:
		results_csv = run_folder / "results.csv"
		if not results_csv.exists():
			raise FileNotFoundError(f"results.csv not found: {results_csv}")

		dataframe = self.normalize_columns(pd.read_csv(results_csv))
		if dataframe.empty:
			raise ValueError(f"results.csv is empty: {results_csv}")

		x_column = "epoch" if "epoch" in dataframe.columns else dataframe.columns[0]

		loss_columns = self.available_metric_columns(
			dataframe,
			[
				"train/box_loss",
				"train/seg_loss",
				"train/cls_loss",
				"train/dfl_loss",
				"val/box_loss",
				"val/seg_loss",
				"val/cls_loss",
				"val/dfl_loss",
			],
		)
		metric_columns = self.available_metric_columns(
			dataframe,
			[
				"metrics/precision(B)",
				"metrics/recall(B)",
				"metrics/mAP50(B)",
				"metrics/mAP50-95(B)",
				"metrics/precision(M)",
				"metrics/recall(M)",
				"metrics/mAP50(M)",
				"metrics/mAP50-95(M)",
			],
		)

		if not loss_columns and not metric_columns:
			numeric_columns = [
				column
				for column in dataframe.columns
				if column != x_column and pd.api.types.is_numeric_dtype(dataframe[column])
			]
			loss_columns = numeric_columns[:4]

		figure, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True)
		figure.suptitle(f"Training Progress: {run_folder.name}")

		if loss_columns:
			for column in loss_columns:
				axes[0].plot(dataframe[x_column], dataframe[column], label=column)
			axes[0].set_ylabel("Loss")
			axes[0].grid(True, alpha=0.3)
			axes[0].legend()
		else:
			axes[0].text(0.5, 0.5, "No loss columns found", ha="center", va="center", transform=axes[0].transAxes)
			axes[0].set_axis_off()

		if metric_columns:
			for column in metric_columns:
				axes[1].plot(dataframe[x_column], dataframe[column], label=column)
			axes[1].set_ylabel("Metric")
			axes[1].grid(True, alpha=0.3)
			axes[1].legend()
		else:
			axes[1].text(0.5, 0.5, "No metric columns found", ha="center", va="center", transform=axes[1].transAxes)
			axes[1].set_axis_off()

		axes[1].set_xlabel(x_column)
		plt.tight_layout()
		output_image = Path.cwd() / f"training_progress_{run_folder.name}.png"
		figure.savefig(output_image, dpi=150, bbox_inches="tight")
		plt.close(figure)
		print(f"Saved training plot: {output_image}")

	def run(self) -> None:
		run_folders = self.discover_run_folders()
		selected_folder = self.select_run_folder(run_folders)
		self.plot_training_progress(selected_folder)


def main() -> None:
	viewer = AiTrainStatViewer()
	viewer.run()


if __name__ == "__main__":
	main()