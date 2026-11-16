import { Deck, MapView, type MapViewState } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { Matrix4 } from '@math.gl/core';
import { type VoxelData, VoxelLayer } from 'deck.gl-voxel';
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { datasets } from './datasets.js';
import { FrameCache } from './frame-cache.js';
import { pickVolumeSample } from './volume-hover.js';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

const HOUR_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 20_000;
const PLAYBACK_DELAY_MS = 700;
const PLAYBACK_BUFFER_FRAMES = 2;
const STATUS_TEXT = { ready: '', loading: 'Loading…', buffering: 'Buffering…' };
const MAP_ANGLE = { pitch: 48, bearing: -12 };
const hourFormat = new Intl.DateTimeFormat('en', {
  timeZone: 'UTC',
  timeZoneName: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Copies the MapLibre camera into deck.gl's flat map view.
 * @param map - MapLibre map that holds the current camera.
 * @returns The camera in deck.gl's MapView format.
 */
function getViewState(map: MapLibreMap): MapViewState {
  const { lng, lat } = map.getCenter();

  return {
    longitude: lng,
    latitude: lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

/**
 * Looks up a required element and checks its DOM type.
 * @param id - Element ID in index.html.
 * @param type - Expected browser element constructor.
 * @returns The matching DOM element.
 * @throws {Error} If the element is missing or has the wrong type.
 */
function getElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);

  if (!(element instanceof type)) {
    throw new Error(`Missing or invalid element: ${id}`);
  }

  return element;
}

/**
 * Shows a slider's formatted value next to it and to screen readers.
 * @param input - Slider with the numeric value.
 * @param output - Visible value next to the slider.
 * @param label - Formatted value with units when applicable.
 */
function showSliderValue(input: HTMLInputElement, output: HTMLOutputElement, label: string): void {
  output.value = label;
  input.setAttribute('aria-valuetext', label);
}

/**
 * Starts the basemap, WebGPU overlay, and dataset and time controls.
 * @throws {Error} If WebGPU is unavailable or a required control is missing.
 */
async function start(): Promise<void> {
  const canvas = getElement('volume', HTMLCanvasElement);
  const datasetPicker = getElement('dataset', HTMLSelectElement);
  const modePicker = getElement('render-mode', HTMLSelectElement);
  const isovalueControl = getElement('isovalue-control', HTMLDivElement);
  const isovalue = getElement('isovalue', HTMLInputElement);
  const isovalueValue = getElement('isovalue-value', HTMLOutputElement);
  const description = getElement('description', HTMLParagraphElement);
  const credit = getElement('credit', HTMLSpanElement);
  const source = getElement('source', HTMLAnchorElement);
  const slider = getElement('hour', HTMLInputElement);
  const play = getElement('play', HTMLButtonElement);
  const speed = getElement('speed', HTMLSelectElement);
  const density = getElement('density', HTMLInputElement);
  const densityValue = getElement('density-value', HTMLOutputElement);
  const exaggeration = getElement('exaggeration', HTMLInputElement);
  const exaggerationValue = getElement('exaggeration-value', HTMLOutputElement);
  const time = getElement('time', HTMLOutputElement);
  const panel = getElement('controls', HTMLElement);
  const tooltip = getElement('tooltip', HTMLDivElement);

  if (!('gpu' in navigator)) {
    throw new Error('Open this example in a browser with WebGPU enabled.');
  }

  setWorkerUrl(workerUrl);

  const lifetime = new AbortController();
  const listenerOptions = { signal: lifetime.signal };
  let dataset = datasets.helene;
  const map = new MapLibreMap({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: dataset.center,
    zoom: dataset.zoom,
    ...MAP_ANGLE,
    renderWorldCopies: false,
    dragRotate: { around: 'center', movement: 'linear' },
  });

  map.addControl(new NavigationControl(), 'top-right');

  const deck = new Deck({
    canvas,
    views: new MapView({ repeat: false }),
    viewState: getViewState(map),
    controller: false,
    useDevicePixels: 1,
    deviceProps: {
      type: 'webgpu',
      adapters: [webgpuAdapter],
      createCanvasContext: { alphaMode: 'premultiplied' },
      onError: reportError,
    },
    onError: reportError,
  });
  let modelMatrix = new Matrix4();
  let frames: FrameCache | undefined;
  let datasetRequest: AbortController | undefined;
  let frameRequest: AbortController | undefined;
  let bufferRequest: AbortController | undefined;
  let startingPlayback = false;
  let frame: VoxelData | undefined;
  let playing = false;
  let playbackTimer: number | undefined;

  /**
   * Combines a request's cancellation, the page lifetime and a network timeout.
   * @param request - Controller for the current request.
   * @returns A signal that aborts when any of those conditions is met.
   */
  function requestSignal(request: AbortController): AbortSignal {
    return AbortSignal.any([
      request.signal,
      lifetime.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
  }

  /**
   * Updates playback state and cancels any scheduled advance when paused.
   * @param enabled - Whether frames should advance automatically.
   */
  function setPlaying(enabled: boolean): void {
    playing = enabled;
    play.textContent = enabled ? 'Pause' : 'Play';

    if (!enabled) {
      window.clearTimeout(playbackTimer);
      startingPlayback = false;

      if (panel.dataset.state === 'buffering') {
        setStatus('ready');
      }
    }
  }

  /** Dismisses the current sample readout. */
  function hideTooltip(): void {
    tooltip.hidden = true;
  }

  /** Synchronizes the two canvases when the map camera or viewport changes. */
  function syncCamera(): void {
    hideTooltip();
    deck.setProps({ viewState: getViewState(map) });
  }

  map.on('move', syncCamera);
  map.on('resize', syncCamera);
  map.on('mouseout', hideTooltip);
  map.on('mousedown', hideTooltip);
  map.on('mousemove', ({ point, originalEvent }) => {
    if (
      !frame ||
      modePicker.value === 'isosurface' ||
      !deck.isInitialized ||
      originalEvent.buttons ||
      map.isMoving()
    ) {
      hideTooltip();
      return;
    }

    const viewport = deck.getViewports()[0];

    if (!viewport) {
      return;
    }

    const sample = pickVolumeSample(
      frame,
      viewport,
      [point.x, point.y],
      modelMatrix,
      dataset.transferFunction,
      dataset.valueRange,
      density.valueAsNumber,
    );

    if (!sample) {
      hideTooltip();
      return;
    }

    tooltip.textContent = `${dataset.valueLabel} ${dataset.formatValue(sample.value)} · ${(sample.altitudeMeters / 1000).toFixed(1)} km altitude`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(8, Math.min(point.x + 12, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(point.y + 12, window.innerHeight - tooltip.offsetHeight - 8))}px`;
  });
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        hideTooltip();
      }
    },
    listenerOptions,
  );

  window.addEventListener(
    'pagehide',
    (event) => {
      if (!event.persisted) {
        setPlaying(false);
        lifetime.abort();
        deck.finalize();
        map.remove();
      }
    },
    listenerOptions,
  );

  /**
   * Stretches the volume vertically. Rendering and hover use the same stretch.
   * @param multiplier - Height scale on screen. A value of 20 means twenty times taller.
   */
  function setExaggeration(multiplier: number): void {
    exaggeration.valueAsNumber = multiplier;
    showSliderValue(exaggeration, exaggerationValue, `${multiplier}×`);
    modelMatrix = new Matrix4().scale([1, 1, multiplier]);
  }

  /**
   * Updates the density control and its accessible readout.
   * @param multiplier - How quickly volume opacity builds up. Zero hides the volume.
   */
  function setDensity(multiplier: number): void {
    density.valueAsNumber = multiplier;
    showSliderValue(density, densityValue, `${multiplier.toFixed(1)}×`);
  }

  /** Shows the surface threshold in the current dataset's units. */
  function showIsovalue(): void {
    showSliderValue(isovalue, isovalueValue, dataset.formatValue(isovalue.valueAsNumber));
  }

  /** Shows the controls that apply to the selected render mode. */
  function syncRenderControls(): void {
    const isosurface = modePicker.value === 'isosurface';
    isovalueControl.hidden = !isosurface;
    density.disabled = isosurface;
  }

  /** Opens the selected dataset and loads its initial frame. */
  async function loadSelectedDataset(): Promise<void> {
    const next = datasetPicker.value === 'milton' ? datasets.milton : datasets.helene;
    setPlaying(false);
    datasetRequest?.abort();
    frameRequest?.abort();
    bufferRequest?.abort();
    bufferRequest = undefined;

    const request = new AbortController();
    const signal = requestSignal(request);
    datasetRequest = request;
    dataset = next;
    setExaggeration(next.verticalExaggeration);
    setDensity(next.density);
    const [min, max] = next.valueRange;
    isovalue.min = String(min);
    isovalue.max = String(max);
    isovalue.step = String(next.isovalueStep);
    isovalue.valueAsNumber = (min + max) / 2;
    showIsovalue();
    syncRenderControls();
    frames = undefined;
    frame = undefined;
    slider.disabled = true;
    play.disabled = true;
    time.value = '';
    slider.removeAttribute('aria-valuetext');
    description.textContent = next.description;
    credit.textContent = next.credit;
    source.href = next.source;
    setStatus('loading');
    hideTooltip();
    deck.setProps({ layers: [] });
    map.jumpTo({ center: next.center, zoom: next.zoom, ...MAP_ANGLE });

    try {
      const volumeReader = await next.open(signal);

      signal.throwIfAborted();
      frames = new FrameCache(volumeReader);
      const lastIndex = frames.frameCount - 1;
      slider.max = String(lastIndex);
      selectHour(Math.min(next.initialFrame, lastIndex));
    } catch (error) {
      if (!request.signal.aborted && !lifetime.signal.aborted) {
        reportError(error);
      }
    }
  }

  /** Updates the visible and accessible label for the selected hour. */
  function showHour(): void {
    const label = hourFormat.format(
      dataset.firstTime + slider.valueAsNumber * dataset.stepHours * HOUR_MS,
    );

    showSliderValue(slider, time, label);
  }

  /**
   * Moves the time control and starts loading the requested hour.
   * @param index - Zero-based frame index in the dataset.
   */
  function selectHour(index: number): void {
    slider.value = String(index);
    showHour();
    void loadHour(index);
  }

  /** Waits for the current frame to finish loading before advancing. */
  function scheduleNextHour(): void {
    window.clearTimeout(playbackTimer);

    if (!playing || !frames || frameRequest || startingPlayback) {
      return;
    }

    const index = (slider.valueAsNumber + 1) % frames.frameCount;

    playbackTimer = window.setTimeout(
      () => selectHour(index),
      PLAYBACK_DELAY_MS / Number(speed.value),
    );
  }

  /**
   * Reads ahead in playback order, then fills the rest of the timeline one frame at a time.
   * @param cache - Frame cache for the dataset playing at the time of the click.
   */
  async function bufferPlayback(cache: FrameCache): Promise<void> {
    const request = new AbortController();
    const start = slider.valueAsNumber;
    const count = Math.min(PLAYBACK_BUFFER_FRAMES, cache.frameCount - 1);
    bufferRequest = request;
    startingPlayback = Array.from({ length: count }, (_, index) =>
      cache.has((start + index + 1) % cache.frameCount),
    ).includes(false);

    if (startingPlayback) {
      setStatus('buffering');
    } else {
      scheduleNextHour();
    }

    try {
      for (let offset = 1; offset <= cache.frameCount; offset++) {
        const index = (start + offset) % cache.frameCount;
        const signal = requestSignal(request);
        await cache.read(index, signal);

        signal.throwIfAborted();

        if (startingPlayback && offset === count) {
          startingPlayback = false;
          setStatus('ready');
          scheduleNextHour();
        }
      }
    } catch (error) {
      if (startingPlayback && !request.signal.aborted && !lifetime.signal.aborted) {
        setPlaying(false);
        reportError(error);
      }
    } finally {
      if (bufferRequest === request) {
        bufferRequest = undefined;
      }
    }
  }

  /**
   * Draws the frame with the current render settings.
   * @param volume - Grid values already placed in deck.gl's map coordinates.
   */
  function drawFrame(volume: VoxelData): void {
    deck.setProps({
      layers: [
        new VoxelLayer({
          id: dataset.id,
          volume,
          modelMatrix,
          renderMode: modePicker.value === 'isosurface' ? 'isosurface' : 'volume',
          isovalue: isovalue.valueAsNumber,
          colorBy: dataset.colorBy,
          valueRange: dataset.valueRange,
          transferFunction: dataset.transferFunction,
          opacityUnitDistance: Math.abs(volume.spacing?.[2] ?? 1),
          density: density.valueAsNumber,
        }),
      ],
    });
    hideTooltip();
  }

  /**
   * Fetches the selected hour and replaces the visible volume when it arrives.
   * @param index - Zero-based time index in the active store.
   */
  async function loadHour(index: number): Promise<void> {
    const cache = frames;

    if (!cache) {
      return;
    }

    frameRequest?.abort();
    const request = new AbortController();
    const signal = requestSignal(request);

    frameRequest = request;
    if (!startingPlayback) {
      if (!frame) {
        setStatus('loading');
      } else {
        setStatus(playing && !cache.has(index) ? 'buffering' : 'ready');
      }
    }

    try {
      const volume = await cache.read(index, signal);

      signal.throwIfAborted();
      drawFrame(volume);
      frame = volume;
      slider.disabled = false;
      play.disabled = cache.frameCount < 2;

      if (!startingPlayback) {
        setStatus('ready');
      }
    } catch (error) {
      if (!request.signal.aborted && !lifetime.signal.aborted) {
        setPlaying(false);
        reportError(error);
      }
    } finally {
      if (frameRequest === request) {
        frameRequest = undefined;
        scheduleNextHour();
      }
    }
  }

  /** Applies changes to the render controls to the displayed frame. */
  function redraw(): void {
    if (frame) {
      drawFrame(frame);
    }
  }

  play.addEventListener(
    'click',
    () => {
      setPlaying(!playing);

      if (!playing || !frames) {
        return;
      }

      if (!bufferRequest && !frames.isComplete) {
        void bufferPlayback(frames);
      } else {
        scheduleNextHour();
      }
    },
    listenerOptions,
  );
  slider.addEventListener(
    'input',
    () => {
      setPlaying(false);
      showHour();
    },
    listenerOptions,
  );
  slider.addEventListener('change', () => void loadHour(slider.valueAsNumber), listenerOptions);
  speed.addEventListener('change', scheduleNextHour, listenerOptions);
  modePicker.addEventListener(
    'change',
    () => {
      syncRenderControls();
      redraw();
    },
    listenerOptions,
  );
  isovalue.addEventListener(
    'input',
    () => {
      showIsovalue();
      redraw();
    },
    listenerOptions,
  );
  density.addEventListener(
    'input',
    () => {
      setDensity(density.valueAsNumber);
      redraw();
    },
    listenerOptions,
  );
  exaggeration.addEventListener(
    'input',
    () => {
      setExaggeration(exaggeration.valueAsNumber);
      redraw();
    },
    listenerOptions,
  );

  datasetPicker.addEventListener('change', () => void loadSelectedDataset(), listenerOptions);

  await loadSelectedDataset();
}

/**
 * Sets the panel's loading state and its visible status message.
 * @param state - Controls which loading placeholders to show.
 * @param message - Optional text that replaces the state's default message.
 */
function setStatus(state: keyof typeof STATUS_TEXT, message = STATUS_TEXT[state]): void {
  getElement('controls', HTMLElement).dataset.state = state;
  getElement('status', HTMLSpanElement).textContent = message;
}

/**
 * Shows a data or renderer failure in the controls.
 * @param error - Error from the browser, GPU device, or dataset reader.
 */
function reportError(error: unknown): void {
  setStatus('ready', error instanceof Error ? error.message : String(error));
}

void start().catch(reportError);
