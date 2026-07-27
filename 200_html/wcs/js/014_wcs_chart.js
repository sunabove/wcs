const MIN_X_TICK_COUNT = 10;
const HISTORY_WINDOW_MS = 20 * 1000;
const RUN_INFO_HISTORY_STORAGE_KEY = 'wcs.status.chart.runinfo.v1';
const VEHICLE_SPEED_HISTORY_STORAGE_KEY = 'wcs.status.chart.speed.v1';

function alignToSecondTimestamp(timeMs) {
    const numericTime = Number(timeMs);
    if (!Number.isFinite(numericTime)) {
        return 0;
    }

    return Math.floor(numericTime / 1000) * 1000;
}

function formatSequentialTickLabel(index, tickCount = MIN_X_TICK_COUNT, firstUnit = '', lastUnit = '') {
    const maxCount = Math.max(2, Number(tickCount) || MIN_X_TICK_COUNT);
    const safeIndex = Math.max(0, Math.min(maxCount - 1, Number(index) || 0));
    const baseLabel = String(safeIndex + 1);
    const normalizedFirstUnit = String(firstUnit || '').trim();
    const normalizedLastUnit = String(lastUnit || '').trim();

    if (safeIndex === 0 && normalizedFirstUnit) {
        return `${baseLabel} ${normalizedFirstUnit}`;
    }
    if (safeIndex === (maxCount - 1) && normalizedLastUnit) {
        return `${baseLabel} ${normalizedLastUnit}`;
    }

    return baseLabel;
}

function ensureLinearMinTicks(scale, minTickCount = MIN_X_TICK_COUNT) {
    const tickCount = Math.max(2, Number(minTickCount) || 2);
    const min = Number(scale?.min);
    const max = Number(scale?.max);

    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        return;
    }

    const step = (max - min) / (tickCount - 1);
    const ticks = [];
    for (let i = 0; i < tickCount; i += 1) {
        ticks.push({ value: min + (step * i) });
    }

    scale.ticks = ticks;
}

function formatValueWithUnit(rawValue, unit = '') {
    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
        return unit ? `0${unit}` : '0';
    }

    const absValue = Math.abs(numericValue);
    let valueText = '';
    if (absValue >= 100) {
        valueText = String(Math.round(numericValue));
    } else if (absValue >= 10) {
        valueText = String(Math.round(numericValue * 10) / 10);
    } else {
        valueText = String(Math.round(numericValue * 100) / 100);
    }

    return unit ? `${valueText}${unit}` : valueText;
}

function readJsonFromStorage(key) {
    try {
        const rawValue = window.localStorage.getItem(key);
        if (!rawValue) {
            return null;
        }

        return JSON.parse(rawValue);
    } catch (error) {
        return null;
    }
}

function writeJsonToStorage(key, value) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        // Ignore storage failures.
    }
}

function sanitizeHistoryPoint(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }

    return { x, y };
}

function sanitizeHistoryDataset(data) {
    if (!Array.isArray(data)) {
        return [];
    }

    return data
        .map((point) => sanitizeHistoryPoint(point))
        .filter((point) => point !== null);
}

class WcsHistoryChart {
    constructor(options) {
        this.canvasId = options.canvasId;
        this.storageKey = options.storageKey;
        this.datasetConfigs = options.datasetConfigs;
        this.latestValueKeys = options.latestValueKeys;
        this.initialLatestValues = options.initialLatestValues;
        this.scales = options.scales;
        this.xTickEdgeUnits = options.xTickEdgeUnits || { first: '', last: '' };
        this.metricUpdater = options.metricUpdater;

        this.state = {
            chart: null,
            firstPointAt: 0,
            lastPointAt: 0,
            maxPoints: 240,
            latestValues: { ...this.initialLatestValues },
        };
    }

    buildScalesWithUnitCallbacks() {
        const clonedScales = {};
        Object.entries(this.scales || {}).forEach(([scaleKey, scaleConfig]) => {
            const nextScale = { ...(scaleConfig || {}) };
            const nextTicks = { ...(nextScale.ticks || {}) };

            nextScale.ticks = nextTicks;
            clonedScales[scaleKey] = nextScale;
        });

        return clonedScales;
    }

    createChart() {
        const canvas = document.getElementById(this.canvasId);
        if (!canvas || typeof Chart !== 'function') {
            return;
        }

        const resolvedScales = this.buildScalesWithUnitCallbacks();
        const xTickEdgeUnits = {
            first: String(this.xTickEdgeUnits?.first || '').trim(),
            last: String(this.xTickEdgeUnits?.last || '').trim(),
        };
        this.state.chart = new Chart(canvas, {
            type: 'line',
            plugins: [],
            data: {
                datasets: this.datasetConfigs.map((config) => ({
                    ...config,
                    data: [],
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                layout: {
                    padding: {
                        top: 8,
                        bottom: 6,
                    },
                },
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            boxWidth: 8,
                            boxHeight: 8,
                            font: {
                                size: 10,
                            },
                            padding: 10,
                            usePointStyle: true,
                        },
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const datasetLabel = String(context.dataset?.label || '').trim();
                                const yAxisId = String(context.dataset?.yAxisID || '');
                                const unit = String(resolvedScales?.[yAxisId]?.unit || '');
                                const valueText = formatValueWithUnit(context?.parsed?.y, unit);
                                return datasetLabel ? `${datasetLabel}: ${valueText}` : valueText;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        type: 'linear',
                        afterBuildTicks(scale) {
                            ensureLinearMinTicks(scale, MIN_X_TICK_COUNT);
                        },
                        ticks: {
                            count: MIN_X_TICK_COUNT,
                            callback(value, index, ticks) {
                                return formatSequentialTickLabel(index, ticks?.length, xTickEdgeUnits.first, xTickEdgeUnits.last);
                            },
                            maxRotation: 0,
                            autoSkip: false,
                        },
                        grid: {
                            color: 'rgba(173, 181, 189, 0.2)',
                        },
                    },
                    ...resolvedScales,
                },
            },
        });

        this.restoreFromStorage();
        this.applyFixedHistoryWindowToXAxis();
        this.state.chart.update('none');
    }

    updateMetric(topic, value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return;
        }

        const isUpdated = this.metricUpdater(topic, numericValue, this.state.latestValues);
        if (!isUpdated) {
            return;
        }

        this.pushHistoryPoint();
    }

    pushHistoryPoint(forcePush = false) {
        if (!this.state.chart) {
            return;
        }

        const hasAnyValue = Object.values(this.state.latestValues).some((value) => Number.isFinite(value));
        if (!hasAnyValue) {
            return;
        }

        const now = Date.now();
        if (!forcePush && this.state.lastPointAt > 0 && (now - this.state.lastPointAt) < 900) {
            return;
        }

        if (this.state.firstPointAt === 0) {
            this.state.firstPointAt = now;
        }

        this.state.lastPointAt = now;
        const pointX = alignToSecondTimestamp(now);

        const datasets = this.state.chart.data.datasets;
        const lastDataIndex = datasets[0].data.length - 1;
        const lastPoint = lastDataIndex >= 0 ? datasets[0].data[lastDataIndex] : null;

        if (lastPoint && Number(lastPoint.x) === pointX) {
            this.latestValueKeys.forEach((key, datasetIndex) => {
                datasets[datasetIndex].data[lastDataIndex].y = this.state.latestValues[key];
            });
        } else {
            this.latestValueKeys.forEach((key, datasetIndex) => {
                datasets[datasetIndex].data.push({ x: pointX, y: this.state.latestValues[key] });
            });
        }

        this.trimDatasetsToRecentWindow();

        if (datasets[0].data.length > this.state.maxPoints) {
            datasets.forEach((dataset) => {
                dataset.data.shift();
            });
        }

        this.applyFixedHistoryWindowToXAxis();
        this.state.chart.update('none');
        this.saveToStorage();
    }

    trimDatasetsToRecentWindow(windowMs = HISTORY_WINDOW_MS) {
        const datasets = this.state.chart?.data?.datasets;
        if (!Array.isArray(datasets) || datasets.length === 0) {
            return;
        }

        const baseDataset = datasets[0];
        if (!baseDataset || !Array.isArray(baseDataset.data) || baseDataset.data.length === 0) {
            return;
        }

        const latestPoint = baseDataset.data[baseDataset.data.length - 1];
        const latestX = Number(latestPoint?.x);
        if (!Number.isFinite(latestX)) {
            return;
        }

        const nowX = alignToSecondTimestamp(Date.now());
        const referenceMaxX = Math.max(latestX, nowX);
        const minX = referenceMaxX - Math.max(1000, Number(windowMs) || HISTORY_WINDOW_MS);

        const firstKeepIndex = baseDataset.data.findIndex((point) => Number(point?.x) >= minX);
        if (firstKeepIndex <= 0) {
            return;
        }

        datasets.forEach((dataset) => {
            if (!Array.isArray(dataset.data)) {
                return;
            }

            dataset.data.splice(0, firstKeepIndex);
        });
    }

    applyFixedHistoryWindowToXAxis(windowMs = HISTORY_WINDOW_MS) {
        const chart = this.state.chart;
        const xScale = chart?.options?.scales?.x;
        const datasets = chart?.data?.datasets;
        if (!xScale || !Array.isArray(datasets) || datasets.length === 0) {
            return;
        }

        const baseDataset = datasets[0];
        const hasData = Array.isArray(baseDataset?.data) && baseDataset.data.length > 0;
        const latestX = hasData ? Number(baseDataset.data[baseDataset.data.length - 1]?.x) : 0;
        const safeLatestX = Number.isFinite(latestX) ? latestX : 0;

        const nowX = alignToSecondTimestamp(Date.now());
        const maxX = Math.max(windowMs, safeLatestX, nowX);
        const minX = maxX - windowMs;
        xScale.min = minX;
        xScale.max = maxX;
    }

    saveToStorage() {
        const chart = this.state.chart;
        if (!chart || !Array.isArray(chart.data?.datasets)) {
            return;
        }

        const payload = {
            firstPointAt: Number(this.state.firstPointAt) || 0,
            lastPointAt: Number(this.state.lastPointAt) || 0,
            latestValues: this.state.latestValues,
            datasets: chart.data.datasets.map((dataset) => sanitizeHistoryDataset(dataset.data)),
            savedAt: Date.now(),
        };

        writeJsonToStorage(this.storageKey, payload);
    }

    restoreFromStorage() {
        const chart = this.state.chart;
        if (!chart || !Array.isArray(chart.data?.datasets)) {
            return;
        }

        const payload = readJsonFromStorage(this.storageKey);
        if (!payload || !Array.isArray(payload.datasets)) {
            return;
        }

        chart.data.datasets.forEach((dataset, index) => {
            dataset.data = sanitizeHistoryDataset(payload.datasets[index]);
        });

        this.trimDatasetsToRecentWindow(HISTORY_WINDOW_MS);

        this.state.firstPointAt = Number(payload.firstPointAt) || 0;
        this.state.lastPointAt = Number(payload.lastPointAt) || 0;

        if (payload.latestValues && typeof payload.latestValues === 'object') {
            this.state.latestValues = {
                ...this.state.latestValues,
                ...payload.latestValues,
            };
        }

        chart.update('none');
    }
}

class WcsChartManager {
    constructor() {
        this.runInfoChart = new WcsHistoryChart({
            canvasId: 'run-info-history-chart',
            storageKey: RUN_INFO_HISTORY_STORAGE_KEY,
            xTickEdgeUnits: {
                first: '%',
                last: '분',
            },
            latestValueKeys: ['batteryPercent', 'availableMinutes', 'elapsedMinutes', 'distanceKm'],
            initialLatestValues: {
                batteryPercent: null,
                availableMinutes: null,
                elapsedMinutes: null,
                distanceKm: null,
            },
            metricUpdater(topic, numericValue, latestValues) {
                if (topic === 'vehicle/battery/remain_amount') {
                    latestValues.batteryPercent = numericValue;
                    return true;
                }
                if (topic === 'vehicle/drive/available_time') {
                    latestValues.availableMinutes = numericValue / 60;
                    return true;
                }
                if (topic === 'vehicle/drive/elapsed_time') {
                    latestValues.elapsedMinutes = numericValue / 60;
                    return true;
                }
                if (topic === 'vehicle/drive/total_distance') {
                    latestValues.distanceKm = numericValue / 1000;
                    return true;
                }

                return false;
            },
            datasetConfigs: [
                {
                    label: '배터리(%)',
                    borderColor: '#2f9e44',
                    backgroundColor: 'rgba(47, 158, 68, 0.12)',
                    yAxisID: 'yBattery',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '주행가능',
                    borderColor: '#1c7ed6',
                    backgroundColor: 'rgba(28, 126, 214, 0.12)',
                    yAxisID: 'yTime',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '주행시간',
                    borderColor: '#f08c00',
                    backgroundColor: 'rgba(240, 140, 0, 0.12)',
                    yAxisID: 'yTime',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '주행거리',
                    borderColor: '#6741d9',
                    backgroundColor: 'rgba(103, 65, 217, 0.12)',
                    yAxisID: 'yDistance',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
            ],
            scales: {
                yBattery: {
                    type: 'linear',
                    position: 'left',
                    unit: '%',
                    min: 0,
                    max: 100,
                    ticks: {
                        padding: 6,
                    },
                    title: {
                        display: false,
                    },
                },
                yTime: {
                    type: 'linear',
                    position: 'right',
                    unit: '분',
                    grace: '10%',
                    ticks: {
                        padding: 6,
                    },
                    title: {
                        display: false,
                    },
                    grid: {
                        drawOnChartArea: false,
                    },
                },
                yDistance: {
                    type: 'linear',
                    position: 'right',
                    unit: 'km',
                    grace: '10%',
                    display: false,
                    grid: {
                        drawOnChartArea: false,
                    },
                },
            },
        });

        this.vehicleSpeedChart = new WcsHistoryChart({
            canvasId: 'vehicle-speed-history-chart',
            storageKey: VEHICLE_SPEED_HISTORY_STORAGE_KEY,
            xTickEdgeUnits: {
                first: 'km/h',
                last: 'km/h/s',
            },
            latestValueKeys: ['speedKmh', 'maxSpeedKmh', 'accelerationKmhPerSec'],
            initialLatestValues: {
                speedKmh: null,
                maxSpeedKmh: null,
                accelerationKmhPerSec: null,
            },
            metricUpdater(topic, numericValue, latestValues) {
                if (topic === 'vehicle/linear/speed') {
                    latestValues.speedKmh = numericValue * 3.6;
                    return true;
                }
                if (topic === 'vehicle/linear/max_speed') {
                    latestValues.maxSpeedKmh = numericValue * 3.6;
                    return true;
                }
                if (topic.includes('/acceleration')) {
                    latestValues.accelerationKmhPerSec = numericValue * 3.6;
                    return true;
                }

                return false;
            },
            datasetConfigs: [
                {
                    label: '현재 속도',
                    borderColor: '#228be6',
                    backgroundColor: 'rgba(34, 139, 230, 0.12)',
                    yAxisID: 'ySpeed',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '최고 속도',
                    borderColor: '#12b886',
                    backgroundColor: 'rgba(18, 184, 134, 0.12)',
                    yAxisID: 'ySpeed',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '가속도',
                    borderColor: '#f08c00',
                    backgroundColor: 'rgba(240, 140, 0, 0.12)',
                    yAxisID: 'yAcceleration',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
            ],
            scales: {
                ySpeed: {
                    type: 'linear',
                    position: 'left',
                    unit: 'km/h',
                    grace: '10%',
                    ticks: {
                        padding: 6,
                    },
                    title: {
                        display: false,
                    },
                    grid: {
                        color: 'rgba(173, 181, 189, 0.2)',
                    },
                },
                yAcceleration: {
                    type: 'linear',
                    position: 'right',
                    unit: 'km/h/s',
                    grace: '10%',
                    ticks: {
                        padding: 6,
                    },
                    title: {
                        display: false,
                    },
                    grid: {
                        drawOnChartArea: false,
                    },
                },
            },
        });
    }

    createRunInfoHistoryChart() {
        this.runInfoChart.createChart();
    }

    createVehicleSpeedHistoryChart() {
        this.vehicleSpeedChart.createChart();
    }

    updateRunInfoHistoryMetric(topic, value) {
        this.runInfoChart.updateMetric(topic, value);
    }

    updateVehicleSpeedHistoryMetric(topic, value) {
        this.vehicleSpeedChart.updateMetric(topic, value);
    }
}

const wcsChartManager = new WcsChartManager();

function createRunInfoHistoryChart() {
    wcsChartManager.createRunInfoHistoryChart();
}

function createVehicleSpeedHistoryChart() {
    wcsChartManager.createVehicleSpeedHistoryChart();
}

function updateRunInfoHistoryMetric(topic, value) {
    wcsChartManager.updateRunInfoHistoryMetric(topic, value);
}

function updateVehicleSpeedHistoryMetric(topic, value) {
    wcsChartManager.updateVehicleSpeedHistoryMetric(topic, value);
}

window.createRunInfoHistoryChart = createRunInfoHistoryChart;
window.createVehicleSpeedHistoryChart = createVehicleSpeedHistoryChart;
window.updateRunInfoHistoryMetric = updateRunInfoHistoryMetric;
window.updateVehicleSpeedHistoryMetric = updateVehicleSpeedHistoryMetric;
