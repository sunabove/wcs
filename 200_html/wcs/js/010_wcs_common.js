
// wcs common js for vehicle pages

function setHeaderMenuCss() {
    // 현재 페이지의 파일명 추출
    var currentPage = window.location.pathname.split('/').pop();
    
    // 모든 네비게이션 링크에 대해 처리
    $('header .nav a[href]').each(function() {
        var $link = $(this);
        var linkPage = $link.attr('href');
        
        // 기존 클래스 제거
        $link.removeClass('text-white text-secondary');
        
        // 현재 페이지와 일치하는지 확인하여 클래스 추가
        if (linkPage === currentPage) {
           $link.addClass('text-white'); 
        } else {
            $link.addClass('text-secondary');
        }
    });
}

function getVehicleDirectionButtonSelector() {
    return '#vehicle-forward, #vehicle-backward, #vehicle-turn-left, #vehicle-turn-right, #vehicle-stop';
}

function getVehicleCommandByButtonId(buttonId) {
    switch (String(buttonId || '')) {
        case 'vehicle-forward':
            return 1;
        case 'vehicle-backward':
            return 2;
        case 'vehicle-turn-left':
            return 3;
        case 'vehicle-turn-right':
            return 4;
        case 'vehicle-stop':
        default:
            return 0;
    }
}

function getVehicleButtonIdByCommand(command) {
    switch (Number(command)) {
        case 1:
            return 'vehicle-forward';
        case 2:
            return 'vehicle-backward';
        case 3:
            return 'vehicle-turn-left';
        case 4:
            return 'vehicle-turn-right';
        case 0:
        default:
            return 'vehicle-stop';
    }
}

function getVehicleDriveModeByCommand(commandValue) {
    switch (Number(commandValue)) {
        case 1:
            return 'forward';
        case 2:
            return 'backward';
        case 3:
            return 'left';
        case 4:
            return 'right';
        case 0:
        default:
            return 'stop';
    }
}

function getVehicleHighlightWheelKeysByCommand(commandValue) {
    switch (Number(commandValue)) {
        case 1:
            return ['fl', 'fr'];
        case 2:
            return ['rl', 'rr'];
        case 3:
            return ['fr', 'rr'];
        case 4:
            return ['fl', 'rl'];
        default:
            return [];
    }
}

function getCommandSignedWheelRpm(commandValue, wheelKey, rpmMagnitude) {
    const absRpm = Math.max(0, Math.abs(Number(rpmMagnitude) || 0));
    const normalizedWheelKey = String(wheelKey || '').trim().toLowerCase();

    switch (Number(commandValue)) {
        case 0:
            return 0;
        case 1:
            return absRpm;
        case 2:
            return -absRpm;
        case 3:
            return (normalizedWheelKey === 'fl' || normalizedWheelKey === 'rl') ? -absRpm : absRpm;
        case 4:
            return (normalizedWheelKey === 'fl' || normalizedWheelKey === 'rl') ? absRpm : -absRpm;
        default:
            return Number(rpmMagnitude) || 0;
    }
}

function syncVehicleDirectionButtons(commandValue, buttonSelector) {
    const selector = String(buttonSelector || getVehicleDirectionButtonSelector());

    $(selector)
        .removeClass('active text-white')
        .addClass('text-black');

    const activeButtonId = getVehicleButtonIdByCommand(commandValue);
    const $activeButton = $('#' + activeButtonId);
    if ($activeButton.length === 0) {
        return false;
    }

    $activeButton
        .addClass('active text-white')
        .removeClass('text-black');

    return true;
}

window.getVehicleDirectionButtonSelector = getVehicleDirectionButtonSelector;
window.getVehicleCommandByButtonId = getVehicleCommandByButtonId;
window.getVehicleButtonIdByCommand = getVehicleButtonIdByCommand;
window.getVehicleDriveModeByCommand = getVehicleDriveModeByCommand;
window.getVehicleHighlightWheelKeysByCommand = getVehicleHighlightWheelKeysByCommand;
window.getCommandSignedWheelRpm = getCommandSignedWheelRpm;
window.syncVehicleDirectionButtons = syncVehicleDirectionButtons;

// 페이지 로드 시 실행 
$(document).ready(function() {
    setHeaderMenuCss();
});
