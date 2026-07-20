const runInfoHistoryState = {
    chart: null,
    labels: [],
    latestValues: {
        batteryPercent: null,
        availableMinutes: null,
        elapsedMinutes: null,
        distanceKm: null,
    },
    lastPointAt: 0,
    maxPoints: 30,
};

function formatRunInfoChartTimeLabel(dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function createRunInfoHistoryChart() {
    const canvas = document.getElementById('run-info-history-chart');
    if (!canvas || typeof Chart !== 'function') {
        return;
    }

    runInfoHistoryState.chart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: runInfoHistoryState.labels,
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
                    ticks: {
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 6,
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
                        callback(value, index, ticks) {
                            const label = String(value);
                            return index === ticks.length - 1 ? `${label}(%)` : label;
                        },
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
                        callback(value, index, ticks) {
                            const label = String(value);
                            return index === ticks.length - 1 ? `${label}(분)` : label;
                        },
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

    runInfoHistoryState.lastPointAt = now;
    runInfoHistoryState.labels.push(formatRunInfoChartTimeLabel(new Date(now)));
    runInfoHistoryState.chart.data.datasets[0].data.push(latest.batteryPercent);
    runInfoHistoryState.chart.data.datasets[1].data.push(latest.availableMinutes);
    runInfoHistoryState.chart.data.datasets[2].data.push(latest.elapsedMinutes);
    runInfoHistoryState.chart.data.datasets[3].data.push(latest.distanceKm);

    if (runInfoHistoryState.labels.length > runInfoHistoryState.maxPoints) {
        runInfoHistoryState.labels.shift();
        runInfoHistoryState.chart.data.datasets.forEach((dataset) => {
            dataset.data.shift();
        });
    }

    runInfoHistoryState.chart.update('none');
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