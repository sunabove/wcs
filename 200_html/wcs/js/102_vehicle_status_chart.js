const runInfoHistoryState = {
    chart: null,
    labels: [],
    firstPointAt: 0,
    latestValues: {
        batteryPercent: null,
        availableMinutes: null,
        elapsedMinutes: null,
        distanceKm: null,
    },
    lastPointAt: 0,
    maxPoints: 240,
};

const vehicleSpeedHistoryState = {
    chart: null,
    labels: [],
    firstPointAt: 0,
    latestValues: {
        speedKmh: null,
        maxSpeedKmh: null,
        accelerationKmhPerSec: null,
    },
    lastPointAt: 0,
    maxPoints: 240,
};

const MIN_X_TICK_COUNT = 4;
const HISTORY_WINDOW_MS = 20 * 1000;
const RUN_INFO_HISTORY_STORAGE_KEY = 'wcs.status.chart.runinfo.v1';
const VEHICLE_SPEED_HISTORY_STORAGE_KEY = 'wcs.status.chart.speed.v1';

function createXAxisEdgeUnitLabelPlugin(options, pluginId) {
    const leftUnitText = String(options?.leftUnitText || '');
    const rightUnitText = String(options?.rightUnitText || '');

    return {
        id: pluginId,
        afterDraw(chart) {
            if (!leftUnitText && !rightUnitText) {
                return;
            }

            const { ctx, chartArea } = chart;
            if (!ctx || !chartArea) {
                return;
            }

            const labelY = Math.max(12, chartArea.top - 4);

            ctx.save();
            ctx.font = '600 11px sans-serif';
            ctx.fillStyle = '#5f6b76';
            ctx.textBaseline = 'bottom';

            if (leftUnitText) {
                ctx.textAlign = 'left';
                ctx.fillText(leftUnitText, chartArea.left + 2, labelY);
            }

            if (rightUnitText) {
                ctx.textAlign = 'right';
                ctx.fillText(rightUnitText, chartArea.right - 2, labelY);
            }

            ctx.restore();
        },
    };
}

function formatRunInfoChartTimeLabel(elapsedMs) {
    const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function alignToSecondTimestamp(timeMs) {
    const numericTime = Number(timeMs);
    if (!Number.isFinite(numericTime)) {
        return 0;
    }

    return Math.floor(numericTime / 1000) * 1000;
}

function formatSecondsFromNowLabel(pointX, axisMaxX) {
    const numericPointX = Number(pointX);
    const numericAxisMaxX = Number(axisMaxX);
    if (!Number.isFinite(numericPointX) || !Number.isFinite(numericAxisMaxX)) {
        return '0초';
    }

    const deltaSeconds = Math.max(0, Math.round((numericAxisMaxX - numericPointX) / 1000));
    return `${deltaSeconds}초`;
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

function getUniqueTimeTickLabel(value, index, ticks, formatLabel, leftEdgeLabel = '', rightEdgeLabel = '') {
    const lastIndex = Math.max(0, ticks.length - 1);
    if (index === 0) {
        return leftEdgeLabel;
    }
    if (index === lastIndex) {
        return rightEdgeLabel;
    }

    return formatLabel(Number(value));
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

function trimDatasetsToRecentWindow(datasets, windowMs = HISTORY_WINDOW_MS) {
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

function applyFixedHistoryWindowToXAxis(chart, windowMs = HISTORY_WINDOW_MS) {
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

function saveRunInfoHistoryToStorage() {
    const chart = runInfoHistoryState.chart;
    if (!chart || !Array.isArray(chart.data?.datasets)) {
        return;
    }

    const payload = {
        firstPointAt: Number(runInfoHistoryState.firstPointAt) || 0,
        lastPointAt: Number(runInfoHistoryState.lastPointAt) || 0,
        latestValues: runInfoHistoryState.latestValues,
        datasets: chart.data.datasets.map((dataset) => sanitizeHistoryDataset(dataset.data)),
        savedAt: Date.now(),
    };

    writeJsonToStorage(RUN_INFO_HISTORY_STORAGE_KEY, payload);
}

function restoreRunInfoHistoryFromStorage() {
    const chart = runInfoHistoryState.chart;
    if (!chart || !Array.isArray(chart.data?.datasets)) {
        return;
    }

    const payload = readJsonFromStorage(RUN_INFO_HISTORY_STORAGE_KEY);
    if (!payload || !Array.isArray(payload.datasets)) {
        return;
    }

    chart.data.datasets.forEach((dataset, index) => {
        dataset.data = sanitizeHistoryDataset(payload.datasets[index]);
    });
    trimDatasetsToRecentWindow(chart.data.datasets, HISTORY_WINDOW_MS);

    runInfoHistoryState.firstPointAt = Number(payload.firstPointAt) || 0;
    runInfoHistoryState.lastPointAt = Number(payload.lastPointAt) || 0;

    if (payload.latestValues && typeof payload.latestValues === 'object') {
        runInfoHistoryState.latestValues = {
            ...runInfoHistoryState.latestValues,
            ...payload.latestValues,
        };
    }

    chart.update('none');
}

function saveVehicleSpeedHistoryToStorage() {
    const chart = vehicleSpeedHistoryState.chart;
    if (!chart || !Array.isArray(chart.data?.datasets)) {
        return;
    }

    const payload = {
        firstPointAt: Number(vehicleSpeedHistoryState.firstPointAt) || 0,
        lastPointAt: Number(vehicleSpeedHistoryState.lastPointAt) || 0,
        latestValues: vehicleSpeedHistoryState.latestValues,
        datasets: chart.data.datasets.map((dataset) => sanitizeHistoryDataset(dataset.data)),
        savedAt: Date.now(),
    };

    writeJsonToStorage(VEHICLE_SPEED_HISTORY_STORAGE_KEY, payload);
}

function restoreVehicleSpeedHistoryFromStorage() {
    const chart = vehicleSpeedHistoryState.chart;
    if (!chart || !Array.isArray(chart.data?.datasets)) {
        return;
    }

    const payload = readJsonFromStorage(VEHICLE_SPEED_HISTORY_STORAGE_KEY);
    if (!payload || !Array.isArray(payload.datasets)) {
        return;
    }

    chart.data.datasets.forEach((dataset, index) => {
        dataset.data = sanitizeHistoryDataset(payload.datasets[index]);
    });
    trimDatasetsToRecentWindow(chart.data.datasets, HISTORY_WINDOW_MS);

    vehicleSpeedHistoryState.firstPointAt = Number(payload.firstPointAt) || 0;
    vehicleSpeedHistoryState.lastPointAt = Number(payload.lastPointAt) || 0;

    if (payload.latestValues && typeof payload.latestValues === 'object') {
        vehicleSpeedHistoryState.latestValues = {
            ...vehicleSpeedHistoryState.latestValues,
            ...payload.latestValues,
        };
    }

    chart.update('none');
}

function createRunInfoHistoryChart() {
    const canvas = document.getElementById('run-info-history-chart');
    if (!canvas || typeof Chart !== 'function') {
        return;
    }

    runInfoHistoryState.chart = new Chart(canvas, {
        type: 'line',
        plugins: [],
        data: {
            datasets: [
                {
                    label: '배터리(%)',
                    data: [],
                    borderColor: '#2f9e44',
                    backgroundColor: 'rgba(47, 158, 68, 0.12)',
                    yAxisID: 'yBattery',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '주행가능',
                    data: [],
                    borderColor: '#1c7ed6',
                    backgroundColor: 'rgba(28, 126, 214, 0.12)',
                    yAxisID: 'yTime',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '주행시간',
                    data: [],
                    borderColor: '#f08c00',
                    backgroundColor: 'rgba(240, 140, 0, 0.12)',
                    yAxisID: 'yTime',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '주행거리',
                    data: [],
                    borderColor: '#6741d9',
                    backgroundColor: 'rgba(103, 65, 217, 0.12)',
                    yAxisID: 'yDistance',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
            ],
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
                            const axisMaxX = Number(ticks?.[ticks.length - 1]?.value);
                            return formatSecondsFromNowLabel(value, axisMaxX);
                        },
                        maxRotation: 0,
                        autoSkip: false,
                    },
                    grid: {
                        color: 'rgba(173, 181, 189, 0.2)',
                    },
                },
                yBattery: {
                    type: 'linear',
                    position: 'left',
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
                    grace: '10%',
                    display: false,
                    grid: {
                        drawOnChartArea: false,
                    },
                },
            },
        },
    });

    restoreRunInfoHistoryFromStorage();
    applyFixedHistoryWindowToXAxis(runInfoHistoryState.chart, HISTORY_WINDOW_MS);
    runInfoHistoryState.chart.update('none');
}

function pushRunInfoHistoryPoint(forcePush = false) {
    if (!runInfoHistoryState.chart) {
        return;
    }

    const latest = runInfoHistoryState.latestValues;
    const hasAnyValue = Object.values(latest).some((value) => Number.isFinite(value));
    if (!hasAnyValue) {
        return;
    }

    const now = Date.now();
    if (!forcePush && runInfoHistoryState.lastPointAt > 0 && (now - runInfoHistoryState.lastPointAt) < 900) {
        return;
    }

    if (runInfoHistoryState.firstPointAt === 0) {
        runInfoHistoryState.firstPointAt = now;
    }

    runInfoHistoryState.lastPointAt = now;
    const runInfoPointAt = alignToSecondTimestamp(now);

    const runInfoDatasets = runInfoHistoryState.chart.data.datasets;
    const lastDataIndex = runInfoDatasets[0].data.length - 1;
    const lastRunInfoPoint = lastDataIndex >= 0 ? runInfoDatasets[0].data[lastDataIndex] : null;

    if (lastRunInfoPoint && Number(lastRunInfoPoint.x) === runInfoPointAt) {
        runInfoDatasets[0].data[lastDataIndex].y = latest.batteryPercent;
        runInfoDatasets[1].data[lastDataIndex].y = latest.availableMinutes;
        runInfoDatasets[2].data[lastDataIndex].y = latest.elapsedMinutes;
        runInfoDatasets[3].data[lastDataIndex].y = latest.distanceKm;
    } else {
        runInfoDatasets[0].data.push({ x: runInfoPointAt, y: latest.batteryPercent });
        runInfoDatasets[1].data.push({ x: runInfoPointAt, y: latest.availableMinutes });
        runInfoDatasets[2].data.push({ x: runInfoPointAt, y: latest.elapsedMinutes });
        runInfoDatasets[3].data.push({ x: runInfoPointAt, y: latest.distanceKm });
    }

    trimDatasetsToRecentWindow(runInfoDatasets, HISTORY_WINDOW_MS);

    if (runInfoHistoryState.chart.data.datasets[0].data.length > runInfoHistoryState.maxPoints) {
        runInfoHistoryState.chart.data.datasets.forEach((dataset) => {
            dataset.data.shift();
        });
    }

    applyFixedHistoryWindowToXAxis(runInfoHistoryState.chart, HISTORY_WINDOW_MS);
    runInfoHistoryState.chart.update('none');
    saveRunInfoHistoryToStorage();
}

function updateRunInfoHistoryMetric(topic, value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return;
    }

    if (topic === 'vehicle/battery/remain_amount') {
        runInfoHistoryState.latestValues.batteryPercent = numericValue;
    } else if (topic === 'vehicle/drive/available_time') {
        runInfoHistoryState.latestValues.availableMinutes = numericValue / 60;
    } else if (topic === 'vehicle/drive/elapsed_time') {
        runInfoHistoryState.latestValues.elapsedMinutes = numericValue / 60;
    } else if (topic === 'vehicle/drive/total_distance') {
        runInfoHistoryState.latestValues.distanceKm = numericValue / 1000;
    } else {
        return;
    }

    pushRunInfoHistoryPoint();
}

function formatVehicleSpeedChartTimeLabel(dateValue) {
    return formatRunInfoChartTimeLabel(dateValue);
}

function createVehicleSpeedHistoryChart() {
    const canvas = document.getElementById('vehicle-speed-history-chart');
    if (!canvas || typeof Chart !== 'function') {
        return;
    }

    vehicleSpeedHistoryState.chart = new Chart(canvas, {
        type: 'line',
        plugins: [],
        data: {
            datasets: [
                {
                    label: '현재 속도',
                    data: [],
                    borderColor: '#228be6',
                    backgroundColor: 'rgba(34, 139, 230, 0.12)',
                    yAxisID: 'ySpeed',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '최고 속도',
                    data: [],
                    borderColor: '#12b886',
                    backgroundColor: 'rgba(18, 184, 134, 0.12)',
                    yAxisID: 'ySpeed',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
                {
                    label: '가속도',
                    data: [],
                    borderColor: '#f08c00',
                    backgroundColor: 'rgba(240, 140, 0, 0.12)',
                    yAxisID: 'yAcceleration',
                    tension: 0.25,
                    pointRadius: 1.8,
                    borderWidth: 2,
                },
            ],
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
                            const axisMaxX = Number(ticks?.[ticks.length - 1]?.value);
                            return formatSecondsFromNowLabel(value, axisMaxX);
                        },
                        maxRotation: 0,
                        autoSkip: false,
                    },
                    grid: {
                        color: 'rgba(173, 181, 189, 0.2)',
                    },
                },
                ySpeed: {
                    type: 'linear',
                    position: 'left',
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
        },
    });

    restoreVehicleSpeedHistoryFromStorage();
    applyFixedHistoryWindowToXAxis(vehicleSpeedHistoryState.chart, HISTORY_WINDOW_MS);
    vehicleSpeedHistoryState.chart.update('none');
}

function pushVehicleSpeedHistoryPoint(forcePush = false) {
    if (!vehicleSpeedHistoryState.chart) {
        return;
    }

    const latest = vehicleSpeedHistoryState.latestValues;
    const hasAnyValue = Object.values(latest).some((value) => Number.isFinite(value));
    if (!hasAnyValue) {
        return;
    }

    const now = Date.now();
    if (!forcePush && vehicleSpeedHistoryState.lastPointAt > 0 && (now - vehicleSpeedHistoryState.lastPointAt) < 900) {
        return;
    }

    if (vehicleSpeedHistoryState.firstPointAt === 0) {
        vehicleSpeedHistoryState.firstPointAt = now;
    }

    vehicleSpeedHistoryState.lastPointAt = now;
    const vehicleSpeedPointAt = alignToSecondTimestamp(now);

    const vehicleSpeedDatasets = vehicleSpeedHistoryState.chart.data.datasets;
    const lastDataIndex = vehicleSpeedDatasets[0].data.length - 1;
    const lastVehicleSpeedPoint = lastDataIndex >= 0 ? vehicleSpeedDatasets[0].data[lastDataIndex] : null;

    if (lastVehicleSpeedPoint && Number(lastVehicleSpeedPoint.x) === vehicleSpeedPointAt) {
        vehicleSpeedDatasets[0].data[lastDataIndex].y = latest.speedKmh;
        vehicleSpeedDatasets[1].data[lastDataIndex].y = latest.maxSpeedKmh;
        vehicleSpeedDatasets[2].data[lastDataIndex].y = latest.accelerationKmhPerSec;
    } else {
        vehicleSpeedDatasets[0].data.push({ x: vehicleSpeedPointAt, y: latest.speedKmh });
        vehicleSpeedDatasets[1].data.push({ x: vehicleSpeedPointAt, y: latest.maxSpeedKmh });
        vehicleSpeedDatasets[2].data.push({ x: vehicleSpeedPointAt, y: latest.accelerationKmhPerSec });
    }

    trimDatasetsToRecentWindow(vehicleSpeedDatasets, HISTORY_WINDOW_MS);

    if (vehicleSpeedHistoryState.chart.data.datasets[0].data.length > vehicleSpeedHistoryState.maxPoints) {
        vehicleSpeedHistoryState.chart.data.datasets.forEach((dataset) => {
            dataset.data.shift();
        });
    }

    applyFixedHistoryWindowToXAxis(vehicleSpeedHistoryState.chart, HISTORY_WINDOW_MS);
    vehicleSpeedHistoryState.chart.update('none');
    saveVehicleSpeedHistoryToStorage();
}

function updateVehicleSpeedHistoryMetric(topic, value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return;
    }

    if (topic === 'vehicle/linear/speed') {
        vehicleSpeedHistoryState.latestValues.speedKmh = numericValue * 3.6;
    } else if (topic === 'vehicle/linear/max_speed') {
        vehicleSpeedHistoryState.latestValues.maxSpeedKmh = numericValue * 3.6;
    } else if (topic.includes('/acceleration')) {
        vehicleSpeedHistoryState.latestValues.accelerationKmhPerSec = numericValue * 3.6;
    } else {
        return;
    }

    pushVehicleSpeedHistoryPoint();
}