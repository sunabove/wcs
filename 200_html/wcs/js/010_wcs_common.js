
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

// 페이지 로드 시 실행 
$(document).ready(function() {
    setHeaderMenuCss();
});
