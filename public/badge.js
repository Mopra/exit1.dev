/**
 * Exit1.dev Embeddable Badge Widget
 * Displays uptime percentage with flexible positioning
 * 
 * Usage Options:
 * 1. Inline: <script src="..." data-check-id="xxx"></script>
 * 2. In Container: <script src="..." data-check-id="xxx" data-container="my-div-id"></script>
 * 3. Fixed Position: <script src="..." data-check-id="xxx" data-position="bottom-right"></script>
 */

(function() {
  'use strict';

  // API endpoint URL
  const API_BASE_URL = 'https://badgedata-xq5qkyhwba-uc.a.run.app';
  
  // Find all script tags with data-check-id attribute
  function initBadges() {
    const scripts = document.querySelectorAll('script[data-check-id]');
    
    scripts.forEach(function(script) {
      const checkId = script.getAttribute('data-check-id');
      const containerId = script.getAttribute('data-container');
      const position = script.getAttribute('data-position');
      
      if (!checkId) {
        console.error('Exit1.dev Badge: Missing data-check-id attribute');
        return;
      }
      
      // Create badge container
      const container = document.createElement('div');
      container.className = 'exit1-badge';
      
      // Determine positioning strategy
      if (position) {
        // Fixed positioning (floating badge)
        applyFixedPosition(container, position);
      } else if (containerId) {
        // Insert into specified container
        const targetContainer = document.getElementById(containerId);
        if (targetContainer) {
          container.style.cssText = 'display: inline-block; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';
          targetContainer.appendChild(container);
        } else {
          console.error('Exit1.dev Badge: Container not found: ' + containerId);
          return;
        }
      } else {
        // Default: inline after script tag
        container.style.cssText = 'display: inline-block; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';
        script.parentNode.insertBefore(container, script.nextSibling);
      }
      
      // Fetch and render badge
      fetchBadgeData(checkId, container);
    });
  }
  
  // Apply fixed positioning styles
  function applyFixedPosition(container, position) {
    const baseStyles = 'position: fixed; z-index: 9999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';
    
    switch(position) {
      case 'bottom-right':
        container.style.cssText = baseStyles + ' bottom: 20px; right: 20px;';
        break;
      case 'bottom-left':
        container.style.cssText = baseStyles + ' bottom: 20px; left: 20px;';
        break;
      case 'top-right':
        container.style.cssText = baseStyles + ' top: 20px; right: 20px;';
        break;
      case 'top-left':
        container.style.cssText = baseStyles + ' top: 20px; left: 20px;';
        break;
      default:
        container.style.cssText = baseStyles + ' bottom: 20px; right: 20px;';
    }
  }
  
  // Fetch badge data from API
  function fetchBadgeData(checkId, container) {
    // Show loading state
    container.innerHTML = '<span style="color: #94a3b8; font-size: 14px;">Loading...</span>';
    
    fetch(API_BASE_URL + '?checkId=' + encodeURIComponent(checkId))
      .then(function(response) {
        if (!response.ok) {
          throw new Error('Failed to load badge data');
        }
        return response.json();
      })
      .then(function(result) {
        if (result.success && result.data) {
          renderBadge(result.data, container);
        } else {
          showError(container, 'Invalid response');
        }
      })
      .catch(function(error) {
        console.error('Exit1.dev Badge Error:', error);
        showError(container, 'Failed to load');
      });
  }
  
  // Render the badge
  function renderBadge(data, container) {
    const isOnline = data.status === 'online' || data.status === 'UP' || data.status === 'REDIRECT';
    const statusColor = isOnline ? '#10b981' : '#ef4444';
    const uptimeText = data.uptimePercentage.toFixed(2) + '% Uptime';
    const statusPageUrl = 'https://app.exit1.dev/status/' + data.checkId;
    
    // Create badge HTML
    const badgeHTML = `
      <a href="${statusPageUrl}" 
         target="_blank" 
         rel="noopener noreferrer"
         style="
           display: inline-flex;
           align-items: center;
           gap: 8px;
           padding: 6px 12px;
           background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
           border: 1px solid rgba(148, 163, 184, 0.2);
           border-radius: 6px;
           text-decoration: none;
           transition: all 0.2s ease;
           cursor: pointer;
           box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
         "
         onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 8px rgba(0, 0, 0, 0.15)';"
         onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(0, 0, 0, 0.1)';">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink: 0;">
          <circle cx="6" cy="6" r="5" fill="${statusColor}" opacity="0.2"/>
          <circle cx="6" cy="6" r="3" fill="${statusColor}"/>
        </svg>
        <span style="
          font-size: 14px;
          font-weight: 500;
          color: #ffffff;
          white-space: nowrap;
        ">
          ${uptimeText}
        </span>
        <span style="
          font-size: 12px;
          color: #94a3b8;
          white-space: nowrap;
        ">
          — Verified by Exit1.dev
        </span>
      </a>
    `;
    
    container.innerHTML = badgeHTML;
  }
  
  // Show error message
  function showError(container, message) {
    container.innerHTML = `
      <span style="
        display: inline-block;
        padding: 6px 12px;
        background: #fee;
        border: 1px solid #fcc;
        border-radius: 4px;
        color: #c33;
        font-size: 14px;
      ">
        Exit1.dev: ${message}
      </span>
    `;
  }
  
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBadges);
  } else {
    initBadges();
  }
})();

