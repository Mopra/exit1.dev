/**
 * Exit1.dev Embeddable Badge Widget (Source)
 * Minified version: public/badge.js
 */

(function() {
  'use strict';

  const API_BASE_URL = 'https://badgedata-xq5qkyhwba-uc.a.run.app';
  const BADGES_ENABLED = false;
  const isMobile = matchMedia('(max-width:640px)');
  const isSmallMobile = matchMedia('(max-width:380px)');

  function applyFixedPosition(container, position) {
    const base = 'position:fixed;z-index:9999;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;';
    container.style.cssText = base + (
      position === 'bottom-left' ? 'bottom:1rem;left:1rem;' :
      position === 'top-right' ? 'top:1rem;right:1rem;' :
      position === 'top-left' ? 'top:1rem;left:1rem;' :
      'bottom:1rem;right:1rem;'
    );
  }

  function fetchBadgeData(checkId, container) {
    container.textContent = 'Loading...';
    const s = container.style;
    s.color = '#94a3b8';
    s.fontSize = '14px';

    fetch(API_BASE_URL + '?checkId=' + encodeURIComponent(checkId))
      .then(r => { if (!r.ok) throw Error('Failed to load'); return r.json(); })
      .then(result => {
        if (result.success && result.data) {
          renderBadge(result.data, container);
        } else {
          showError(container, 'Invalid response');
        }
      })
      .catch(() => showError(container, 'Failed to load'));
  }

  function renderBadge(data, container) {
    const isOnline = data.status === 'online' || data.status === 'UP' || data.status === 'REDIRECT';
    const statusColor = isOnline ? '#10b981' : '#ef4444';
    const uptimeText = data.uptimePercentage.toFixed(2) + '% Uptime';
    const statusPageUrl = 'https://app.exit1.dev/status/' + data.checkId;

    // Create elements using DOM (faster than innerHTML with styles)
    const a = document.createElement('a');
    a.href = statusPageUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const s = a.style;
    s.display = 'inline-flex';
    s.alignItems = 'center';
    s.background = 'rgba(14,165,233,0.15)';
    s.backdropFilter = 'blur(12px)';
    s.WebkitBackdropFilter = 'blur(12px)';
    s.border = '1px solid rgba(125,211,252,0.2)';
    s.borderRadius = '.5rem';
    s.textDecoration = 'none';
    s.transition = 'all .2s ease';
    s.cursor = 'pointer';
    s.boxShadow = '0 25px 50px -12px rgba(0,0,0,0.25)';
    s.maxWidth = '100%';
    s.fontSize = 'clamp(.75rem,2.5vw,.875rem)';
    s.fontFamily = '-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif';

    a.onmouseenter = () => { 
      s.transform = 'translateY(-2px)'; 
      s.boxShadow = '0 25px 50px -12px rgba(14,165,233,0.35)';
      s.borderColor = 'rgba(125,211,252,0.3)';
    };
    a.onmouseleave = () => { 
      s.transform = ''; 
      s.boxShadow = '0 25px 50px -12px rgba(0,0,0,0.25)';
      s.borderColor = 'rgba(125,211,252,0.2)';
    };

    // SVG icon
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('fill', 'none');
    const svgStyle = svg.style;
    svgStyle.flexShrink = '0';
    svgStyle.width = 'clamp(10px,3vw,12px)';
    svgStyle.height = 'clamp(10px,3vw,12px)';

    const circle1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle1.setAttribute('cx', '6');
    circle1.setAttribute('cy', '6');
    circle1.setAttribute('r', '5');
    circle1.setAttribute('fill', statusColor);
    circle1.setAttribute('opacity', '.2');

    const circle2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle2.setAttribute('cx', '6');
    circle2.setAttribute('cy', '6');
    circle2.setAttribute('r', '3');
    circle2.setAttribute('fill', statusColor);

    svg.appendChild(circle1);
    svg.appendChild(circle2);

    // Uptime text
    const uptimeSpan = document.createElement('span');
    uptimeSpan.textContent = uptimeText;
    const uptimeStyle = uptimeSpan.style;
    uptimeStyle.fontWeight = '600';
    uptimeStyle.color = 'rgb(240,249,255)';
    uptimeStyle.whiteSpace = 'nowrap';

    // Verified text with link
    const verifiedContainer = document.createElement('span');
    const verifiedStyle = verifiedContainer.style;
    verifiedStyle.color = 'rgb(186,230,253)';
    verifiedStyle.whiteSpace = 'nowrap';
    verifiedStyle.fontSize = '.85em';
    verifiedStyle.display = 'inline-flex';
    verifiedStyle.alignItems = 'center';
    verifiedStyle.gap = '.25rem';
    
    const verifiedText = document.createTextNode('— Verified by ');
    
    const exitLink = document.createElement('a');
    exitLink.href = 'https://exit1.dev';
    exitLink.textContent = 'Exit1.dev';
    exitLink.target = '_blank';
    exitLink.rel = 'noopener'; // do-follow link (no noreferrer or nofollow)
    const exitLinkStyle = exitLink.style;
    exitLinkStyle.color = 'rgb(186,230,253)';
    exitLinkStyle.textDecoration = 'underline';
    exitLinkStyle.textUnderlineOffset = '2px';
    exitLinkStyle.transition = 'color .2s ease';
    exitLink.onmouseenter = function(e) { 
      e.stopPropagation();
      exitLinkStyle.color = 'rgb(224,242,254)'; 
    };
    exitLink.onmouseleave = function(e) { 
      e.stopPropagation();
      exitLinkStyle.color = 'rgb(186,230,253)'; 
    };
    
    verifiedContainer.appendChild(verifiedText);
    verifiedContainer.appendChild(exitLink);

    a.appendChild(svg);
    a.appendChild(uptimeSpan);
    a.appendChild(verifiedContainer);

    container.textContent = '';
    container.appendChild(a);

    // Responsive behavior with matchMedia
    const updateResponsive = () => {
      if (isSmallMobile.matches) {
        s.gap = '.25rem';
        s.padding = '.25rem .5rem';
      } else if (isMobile.matches) {
        s.gap = '.375rem';
        s.padding = '.375rem .625rem';
      } else {
        s.gap = '.5rem';
        s.padding = '.5rem .75rem';
      }
      verifiedContainer.style.display = isMobile.matches ? 'none' : 'inline-flex';
    };

    updateResponsive();
    isMobile.addListener(updateResponsive);
    isSmallMobile.addListener(updateResponsive);
  }

  function showError(container, message) {
    container.innerHTML = '<span style="display:inline-block;padding:6px 12px;background:#fee;border:1px solid #fcc;border-radius:4px;color:#c33;font-size:14px">Exit1.dev: ' + message + '</span>';
  }

  function initBadges() {
    document.querySelectorAll('script[data-check-id]').forEach(script => {
      const checkId = script.getAttribute('data-check-id');
      const containerId = script.getAttribute('data-container');
      const position = script.getAttribute('data-position');

      if (!checkId) return;

      const container = document.createElement('div');
      container.className = 'exit1-badge';

      if (position) {
        applyFixedPosition(container, position);
      } else if (containerId) {
        const target = document.getElementById(containerId);
        if (!target) return;
        container.style.cssText = 'display:inline-block;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif';
        target.appendChild(container);
      } else {
        container.style.cssText = 'display:inline-block;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif';
        script.parentNode.insertBefore(container, script.nextSibling);
      }

      if (!BADGES_ENABLED) {
        showError(container, 'Badges are disabled');
        return;
      }

      fetchBadgeData(checkId, container);
    });
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBadges);
  } else {
    initBadges();
  }
})();

