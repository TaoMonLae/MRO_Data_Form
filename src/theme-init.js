// External module keeps startup compatible with the production script CSP.
try {
  const saved = localStorage.getItem('mro-theme');
  const theme = ['dark', 'light'].includes(saved) ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#08090a' : '#ffffff');
} catch { /* Storage may be unavailable in restricted browser contexts. */ }
