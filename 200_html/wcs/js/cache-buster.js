/**
 * 브라우저 캐시 방지 유틸리티
 * 모든 로컬 CSS/JS 파일에 타임스탬프를 자동으로 추가합니다.
 */

(function() {
    'use strict';
    
    const timestamp = Date.now();
    
    // 캐시 방지를 위해 모든 로컬 파일에 타임스탬프 추가
    function preventCaching() {
        // CSS 파일들
        const cssFiles = document.querySelectorAll('link[rel="stylesheet"]');
        cssFiles.forEach(link => {
            const href = link.getAttribute('href');
            if (href && !href.startsWith('http') && !href.includes('?v=')) {
                link.href = `${href}${href.includes('?') ? '&' : '?'}v=${timestamp}`;
            }
        });
        
        // JS 파일들 (src 속성이 있는 script 태그)
        const jsFiles = document.querySelectorAll('script[src]');
        jsFiles.forEach(script => {
            const src = script.getAttribute('src');
            if (src && !src.startsWith('http') && !src.includes('?v=')) {
                script.src = `${src}${src.includes('?') ? '&' : '?'}v=${timestamp}`;
            }
        });
    }
    
    // DOM 로드 완료 후 실행
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', preventCaching);
    } else {
        preventCaching();
    }
    
    // 전역으로 타임스탬프 노출 (필요한 경우)
    window.cacheTimestamp = timestamp;
})();