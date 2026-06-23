(function () {
  'use strict';

  function initMegaMenu() {
    const wrap   = document.getElementById('megaWrap');
    const menu   = document.getElementById('megaMenu');
    const trigger = document.getElementById('megaTrigger');

    if (!wrap || !menu || !trigger) return;

    const isTopbar = !!document.querySelector('.topbar');
    let closeTimer = null;

    // ── Positioning ──────────────────────────────────────
    function positionMenu() {
      const tr = trigger.getBoundingClientRect();
      const menuW = menu.classList.contains('is-single') ? 320 : 580;
      const menuH = Math.min(460, window.innerHeight - 80);

      if (isTopbar) {
        // Drop down below the trigger button
        let left = tr.left;
        // Keep within viewport
        if (left + menuW > window.innerWidth - 8) {
          left = window.innerWidth - menuW - 8;
        }
        menu.style.left = Math.max(8, left) + 'px';
        menu.style.top  = (tr.bottom + 6) + 'px';
      } else {
        // Sidebar: fly out to the right of the sidebar
        const sidebar = document.querySelector('.sidebar');
        const sidebarW = sidebar ? sidebar.offsetWidth : 240;

        let top = tr.top - 8;
        // Clamp so menu doesn't go below viewport
        if (top + menuH > window.innerHeight - 8) {
          top = window.innerHeight - menuH - 8;
        }
        menu.style.left = (sidebarW + 6) + 'px';
        menu.style.top  = Math.max(8, top) + 'px';
      }

      menu.style.maxHeight = menuH + 'px';
    }

    // ── Open / close ─────────────────────────────────────
    function openMenu() {
      clearTimeout(closeTimer);
      positionMenu();
      menu.classList.add('is-open');
      wrap.classList.add('is-open');
    }

    function closeMenu() {
      closeTimer = setTimeout(() => {
        menu.classList.remove('is-open');
        wrap.classList.remove('is-open');
      }, 100);
    }

    wrap.addEventListener('mouseenter', openMenu);
    wrap.addEventListener('mouseleave', closeMenu);
    menu.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    menu.addEventListener('mouseleave', closeMenu);

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.remove('is-open');
        wrap.classList.remove('is-open');
      }
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        menu.classList.remove('is-open');
        wrap.classList.remove('is-open');
      }
    });

    // ── Workspace hover → show dashboard panel ────────────
    const wsItems    = menu.querySelectorAll('.mega-ws-item');
    const dashPanels = menu.querySelectorAll('.mega-panel');

    function setActiveWorkspace(wsId) {
      wsItems.forEach(function (item) {
        item.classList.toggle('active', item.dataset.ws === wsId);
      });
      dashPanels.forEach(function (panel) {
        panel.classList.toggle('active', panel.dataset.ws === wsId);
      });
    }

    wsItems.forEach(function (item) {
      item.addEventListener('mouseenter', function () {
        setActiveWorkspace(item.dataset.ws);
      });
    });

    // Activate the first workspace on open
    wrap.addEventListener('mouseenter', function () {
      const first = menu.querySelector('.mega-ws-item');
      if (first) setActiveWorkspace(first.dataset.ws);
    });

    // Re-position on window resize
    window.addEventListener('resize', function () {
      if (menu.classList.contains('is-open')) positionMenu();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMegaMenu);
  } else {
    initMegaMenu();
  }
})();
