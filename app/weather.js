// Current weather from Open-Meteo (free, no account), for the coordinates `npm run sync` looked up.
window.Weather = (function () {
  'use strict';

  const TIMEOUT_MS = 10000;

  // Line icons on a 24-unit grid, drawn in the text color.
  const CLOUD = 'M7 17h10.5a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 7.3 9.6 3.75 3.75 0 0 0 7 17z';
  const RAISED = 'M7 14h10.5a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 7.3 6.6 3.75 3.75 0 0 0 7 14z';
  const SHAPES = {
    sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
    moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
    partly: '<path d="M8.5 3v1.5M3 8.5h1.5M4.6 4.6l1 1M12.4 4.6l-1 1"/><path d="M5.6 11.2a3.5 3.5 0 0 1 6-3.6"/><path d="' + CLOUD + '"/>',
    cloud: '<path d="' + CLOUD + '"/>',
    fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
    rain: '<path d="' + RAISED + '"/><path d="M8.5 17l-1 3M12.5 17l-1 3M16.5 17l-1 3"/>',
    snow: '<path d="' + RAISED + '"/><path d="M8 18.5h.01M12 18.5h.01M16 18.5h.01M10 21h.01M14 21h.01"/>',
    storm: '<path d="' + RAISED + '"/><path d="M12.5 15l-2 3.5h3l-2 3.5"/>',
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (SHAPES[name] || SHAPES.cloud) + '</svg>';
  }

  // WMO weather codes, as Open-Meteo reports them.
  function describe(code, isDay) {
    if (code === 0) return { label: 'Clear', icon: isDay ? 'sun' : 'moon' };
    if (code === 1) return { label: 'Mostly clear', icon: isDay ? 'sun' : 'moon' };
    if (code === 2) return { label: 'Partly cloudy', icon: isDay ? 'partly' : 'cloud' };
    if (code === 3) return { label: 'Cloudy', icon: 'cloud' };
    if (code === 45 || code === 48) return { label: 'Fog', icon: 'fog' };
    if (code >= 51 && code <= 57) return { label: 'Drizzle', icon: 'rain' };
    if (code >= 61 && code <= 67) return { label: 'Rain', icon: 'rain' };
    if (code >= 71 && code <= 77) return { label: 'Snow', icon: 'snow' };
    if (code >= 80 && code <= 82) return { label: 'Showers', icon: 'rain' };
    if (code === 85 || code === 86) return { label: 'Snow showers', icon: 'snow' };
    if (code >= 95) return { label: 'Thunderstorms', icon: 'storm' };
    return { label: '', icon: 'cloud' };
  }

  function current(cfg) {
    const url = 'https://api.open-meteo.com/v1/forecast?forecast_days=1&timezone=auto' +
      '&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min' +
      '&latitude=' + cfg.latitude + '&longitude=' + cfg.longitude + '&temperature_unit=' + (cfg.units || 'fahrenheit');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    return fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('weather service answered ' + res.status);
        return res.json();
      })
      .then((json) => {
        const d = describe(json.current.weather_code, json.current.is_day === 1);
        return {
          temp: Math.round(json.current.temperature_2m),
          high: Math.round(json.daily.temperature_2m_max[0]),
          low: Math.round(json.daily.temperature_2m_min[0]),
          label: d.label,
          icon: d.icon,
        };
      })
      .finally(() => clearTimeout(timer));
  }

  return { current: current, icon: icon };
})();
