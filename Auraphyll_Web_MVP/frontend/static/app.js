/* ==========================================
   AURAPHYLL — App Controller
   Geolocation · Mobile Bottom-Sheet · ALU Plot Manager
   ========================================== */

var map;
var drawnItems;
var drawControl;
var currentPolygon = null;
var isProcessing = false;
var gpsMarker = null;
var saviLayer = null;

/* Grid Heatmap State */
var gridLayerGroup = null;
var activeLayer = 'savi'; // 'savi' or 'ndwi'
var storedGridData = null; // { cells: [...], meanSavi, meanNdwi }
var gridLegendEl = null;
var gridTooltipTimeout = null;

var PRIMARY = "#1B5E20";
var AMBER = "#FFC107";
var DANGER = "#D32F2F";
var BORDER_COLOR = "#E5E7EB";
var API_URL = "/api/analyze";

var STORAGE_KEY = "auraphyll_plots";
var savedPlotsLayerGroup = null;

/* ==========================================
   TOASTS
   ========================================== */
function showToast(message, type, duration) {
    var container = document.getElementById("toast-container");
    var toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "warn");
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
        toast.classList.add("toast-out");
        setTimeout(function () {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, duration || 3500);
}

/* ==========================================
   GEOLOCATION CONTROL
   ========================================== */
var LocateControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
        var container = L.DomUtil.create("div", "leaflet-bar locate-control");
        var btn = L.DomUtil.create("button", "locate-btn", container);
        btn.type = "button";
        btn.title = "Locate Me";
        btn.setAttribute("aria-label", "Locate my position");
        btn.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" fill="currentColor"/></svg>';

        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(btn, "click", function () {
            btn.classList.add("locating");
            map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true, timeout: 10000 });
        });

        this._btn = btn;
        return container;
    },
});

function onLocationFound(e) {
    var locateBtn = document.querySelector(".locate-btn");
    if (locateBtn) locateBtn.classList.remove("locating");

    if (gpsMarker) {
        map.removeLayer(gpsMarker);
    }

    var icon = L.divIcon({
        className: "gps-marker",
        html: '<div class="gps-marker-pulse"></div><div class="gps-marker-dot"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
    });

    gpsMarker = L.marker(e.latlng, { icon: icon, zIndexOffset: 1000 }).addTo(map);
    gpsMarker.bindPopup(
        "<strong>Your Location</strong><br>Lat: " +
            e.latlng.lat.toFixed(5) +
            "<br>Lng: " +
            e.latlng.lng.toFixed(5)
    );

    showToast("Location acquired successfully.", "success", 2500);
}

function onLocationError(e) {
    var locateBtn = document.querySelector(".locate-btn");
    if (locateBtn) locateBtn.classList.remove("locating");

    var msg = "Location unavailable. Please check your GPS.";
    if (e.code === 1) {
        msg = "Location access denied. Please enable GPS in your browser settings.";
    } else if (e.code === 3) {
        msg = "Location request timed out. Please try again.";
    }
    showToast(msg, "error", 4000);
}

/* ==========================================
   MOBILE BOTTOM-SHEET
   ========================================== */
var BottomSheet = {
    panel: null,
    handle: null,
    header: null,
    startY: 0,
    startTranslate: 0,
    currentTranslate: 0,
    sheetHeight: 0,
    peekH: 88,
    isDragging: false,
    state: "peek", // peek | half | full

    init: function () {
        this.panel = document.getElementById("pulse-panel");
        this.handle = document.getElementById("sheet-handle");
        this.header = this.panel.querySelector(".panel-header");

        if (!this._isMobile()) return;

        this.sheetHeight = this.panel.offsetHeight;
        this.peekH = 88;

        // Prevent map panning when interacting with the bottom sheet
        L.DomEvent.disableClickPropagation(this.panel);
        L.DomEvent.disableScrollPropagation(this.panel);

        // Bind drag events to both the handle AND the full panel header
        var dragTargets = [this.handle, this.header];
        var self = this;
        for (var i = 0; i < dragTargets.length; i++) {
            if (!dragTargets[i]) continue;
            dragTargets[i].addEventListener("touchstart", self._onTouchStart.bind(self), { passive: false });
            dragTargets[i].addEventListener("touchmove", self._onTouchMove.bind(self), { passive: false });
            dragTargets[i].addEventListener("touchend", self._onTouchEnd.bind(self), { passive: true });
        }

        // Also allow tapping handle/header to toggle
        this.handle.addEventListener("click", this._onHandleClick.bind(this));
        if (this.header) {
            this.header.addEventListener("click", this._onHandleClick.bind(this));
        }
    },

    _isMobile: function () {
        return window.innerWidth <= 768;
    },

    _getTranslateForState: function (state) {
        var h = this.panel.offsetHeight || window.innerHeight * 0.92;
        if (state === "peek") return h - this.peekH;
        if (state === "half") return h - window.innerHeight * 0.5;
        return 0; // full
    },

    _onTouchStart: function (e) {
        // Stop touch from propagating to the Leaflet map underneath
        e.stopPropagation();
        this.isDragging = true;
        this.panel.classList.add("sheet-dragging");
        this.startY = e.touches[0].clientY;
        this.sheetHeight = this.panel.offsetHeight;
        this.startTranslate = this._getTranslateForState(this.state);
        this.currentTranslate = this.startTranslate;
    },

    _onTouchMove: function (e) {
        if (!this.isDragging) return;
        e.preventDefault();
        e.stopPropagation();
        var deltaY = e.touches[0].clientY - this.startY;
        var newTranslate = this.startTranslate + deltaY;

        // Clamp: can't go above full (0) or below peek
        var maxTranslate = this._getTranslateForState("peek");
        newTranslate = Math.max(0, Math.min(newTranslate, maxTranslate));

        this.currentTranslate = newTranslate;
        this.panel.style.transform = "translateY(" + newTranslate + "px)";
    },

    _onTouchEnd: function (e) {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.panel.classList.remove("sheet-dragging");

        var h = this.panel.offsetHeight;
        var visibleH = h - this.currentTranslate;

        // Snap to closest state
        var peekThreshold = this.peekH + 40;
        var halfThreshold = window.innerHeight * 0.35;
        var fullThreshold = window.innerHeight * 0.7;

        if (visibleH < peekThreshold) {
            this._snapTo("peek");
        } else if (visibleH < halfThreshold) {
            this._snapTo("peek");
        } else if (visibleH < fullThreshold) {
            this._snapTo("half");
        } else {
            this._snapTo("full");
        }
    },

    _onHandleClick: function (e) {
        // Prevent click from reaching the map
        if (e) e.stopPropagation();
        if (this.state === "peek") {
            this._snapTo("half");
        } else if (this.state === "half") {
            this._snapTo("full");
        } else {
            this._snapTo("peek");
        }
    },

    _snapTo: function (state) {
        this.state = state;
        this.panel.classList.remove("sheet-half", "sheet-full");
        this.panel.style.transform = "";

        if (state === "half") {
            this.panel.classList.add("sheet-half");
        } else if (state === "full") {
            this.panel.classList.add("sheet-full");
        }

        // Let map know size changed
        setTimeout(function () {
            if (map) map.invalidateSize();
        }, 400);
    },

    snapToHalf: function () {
        if (this._isMobile()) {
            this._snapTo("half");
        }
    },

    snapToPeek: function () {
        if (this._isMobile()) {
            this._snapTo("peek");
        }
    },
};

/* ==========================================
   MAP INITIALIZATION
   ========================================== */
function initMap() {
    map = L.map("map", {
        center: [22.3072, 73.1812],
        zoom: 15,
        zoomControl: true,
    });

    // Esri World Imagery — free satellite tiles
    L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
            attribution:
                "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
            maxZoom: 19,
        }
    ).addTo(map);

    // FeatureGroup to hold drawn layers
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Layer group for saved ALU plots
    savedPlotsLayerGroup = new L.LayerGroup();
    map.addLayer(savedPlotsLayerGroup);

    // Leaflet.draw control — polygon only
    drawControl = new L.Control.Draw({
        position: "topright",
        draw: {
            polygon: {
                allowIntersection: false,
                shapeOptions: {
                    color: "#43A047",
                    weight: 2.5,
                    opacity: 0.9,
                    fillColor: "#1B5E20",
                    fillOpacity: 0.18,
                },
            },
            polyline: false,
            rectangle: false,
            circle: false,
            marker: false,
            circlemarker: false,
        },
        edit: {
            featureGroup: drawnItems,
            remove: true,
            edit: true,
        },
    });
    map.addControl(drawControl);

    // Locate Me control
    map.addControl(new LocateControl());
    map.on("locationfound", onLocationFound);
    map.on("locationerror", onLocationError);

    // When a polygon is created
    map.on(L.Draw.Event.CREATED, function (e) {
        if (currentPolygon) {
            drawnItems.removeLayer(currentPolygon);
            currentPolygon = null;
        }

        currentPolygon = e.layer;
        drawnItems.addLayer(currentPolygon);
        updateSaveBtnState();
        updateAreaDisplay(currentPolygon);
    });

    // When a polygon is deleted via the edit toolbar
    map.on(L.Draw.Event.DELETED, function (e) {
        var layers = e.layers;
        layers.eachLayer(function (layer) {
            if (layer === currentPolygon) {
                currentPolygon = null;
            }
        });
        updateSaveBtnState();
        updateAreaDisplay(currentPolygon);
    });

    // When a polygon is edited
    map.on(L.Draw.Event.EDITED, function (e) {
        if (currentPolygon) {
            updateAreaDisplay(currentPolygon);
        }
    });

    // Grid layer group for 10x10m cells
    gridLayerGroup = new L.LayerGroup();
    map.addLayer(gridLayerGroup);

    document.getElementById("analyze-btn").addEventListener("click", handleAnalyze);
    document.getElementById("demo-toggle").addEventListener("change", function () {
        var label = document.getElementById("mode-label-text");
        label.textContent = this.checked ? "Demo Mode" : "Live Mode";
    });

    document.getElementById('toggleHeatmap').addEventListener('click', function () {
        if (gridLayerGroup && map.hasLayer(gridLayerGroup)) {
            map.removeLayer(gridLayerGroup);
            if (saviLayer && map.hasLayer(saviLayer)) map.removeLayer(saviLayer);
            removeGridLegend();
        } else {
            if (gridLayerGroup) map.addLayer(gridLayerGroup);
            if (saviLayer) map.addLayer(saviLayer);
            if (storedGridData) updateGridLegend();
        }
    });

    // SAVI/NDWI Layer Toggle Wiring (Action 4)
    var segSavi = document.getElementById('seg-savi');
    var segNdwi = document.getElementById('seg-ndwi');
    var segIndicator = document.getElementById('seg-indicator');

    function setActiveLayer(layer) {
        activeLayer = layer;

        // Update button states
        segSavi.classList.toggle('active', layer === 'savi');
        segNdwi.classList.toggle('active', layer === 'ndwi');

        // Animate indicator
        segIndicator.classList.toggle('ndwi-active', layer === 'ndwi');

        // Re-render grid with new color scale — NO new API call
        if (storedGridData && storedGridData.cells.length > 0) {
            renderGridLayer();
        }

        showToast('Switched to ' + (layer === 'savi' ? 'SAVI (Vegetation Health)' : 'NDWI (Water Stress)') + ' layer.', 'info', 2000);
    }

    segSavi.addEventListener('click', function () { setActiveLayer('savi'); });
    segNdwi.addEventListener('click', function () { setActiveLayer('ndwi'); });

    document.getElementById('clearMap').addEventListener('click', function () {
        // Clear drawn polygons
        if (drawnItems) drawnItems.clearLayers();
        // Remove GEE heatmap overlay
        if (saviLayer) {
            map.removeLayer(saviLayer);
            saviLayer = null;
        }
        // Clear grid layer
        if (gridLayerGroup) gridLayerGroup.clearLayers();
        storedGridData = null;
        removeGridLegend();
        hideGridTooltip();
        // Reset meter and NDWI
        document.getElementById('meter-value').innerText = '\u2014';
        document.getElementById('ndwi-value').innerText = '--';
        var progressSvg = document.getElementById('meter-progress');
        if (progressSvg) {
            progressSvg.style.strokeDashoffset = 452.4;
            progressSvg.style.stroke = 'var(--primary)';
        }
        var meter = document.getElementById('savi-meter');
        if (meter) meter.className = 'savi-meter';
        // Reset AI response to placeholder
        var aiResp = document.getElementById('ai-response');
        aiResp.innerHTML = '';
        aiResp.classList.remove('active', 'error');
        aiResp.innerHTML = '<div class="ai-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" fill="currentColor" /></svg><span>Draw a field polygon on the map, then tap <strong>Analyze Field</strong> to receive AI-powered agronomic insight.</span></div>';
        // Hide error message and chart
        hideError();
        var chartCont = document.getElementById('chart-container');
        if (chartCont) chartCont.style.display = 'none';
        // Reset state
        currentPolygon = null;
        updateSaveBtnState();
        updateAreaDisplay(null);
    });

    // Save plot button
    document.getElementById("save-plot-btn").addEventListener("click", handleSavePlot);
    
    // Download PDF 
    document.getElementById("download-pdf-btn").addEventListener("click", handleDownloadPdf);

    // Plot manager toggle
    document.getElementById("plot-manager-toggle").addEventListener("click", function () {
        var pm = document.getElementById("plot-manager");
        pm.classList.toggle("collapsed");
    });

    // Map rendering stability: invalidate on resize + initial load
    // Multiple timeouts ensure tiles render even if container is still settling
    window.addEventListener('resize', function () {
        setTimeout(function () { if (map) map.invalidateSize(); }, 200);
        setTimeout(function () { if (map) map.invalidateSize(); }, 600);
    });
    setTimeout(function () { if (map) map.invalidateSize(); }, 100);
    setTimeout(function () { if (map) map.invalidateSize(); }, 500);
    setTimeout(function () { if (map) map.invalidateSize(); }, 1500);

    // Initialize plot manager — load saved plots
    PlotManager.init();
}

function updateSaveBtnState() {
    var btn = document.getElementById("save-plot-btn");
    btn.disabled = !currentPolygon;
}

/* ==========================================
   COORDINATE EXTRACTION
   ========================================== */
function extractCoordinates() {
    var latlngs = currentPolygon.getLatLngs()[0]; // outer ring
    var coords = [];
    for (var i = 0; i < latlngs.length; i++) {
        coords.push({ lat: latlngs[i].lat, lng: latlngs[i].lng });
    }
    return coords;
}

function updateAreaDisplay(polygon) {
    var display = document.getElementById("area-display");
    var valueEl = document.getElementById("area-value");
    if (!polygon || !L.GeometryUtil) {
        display.classList.add("hidden");
        return;
    }
    
    var latlngs = polygon.getLatLngs()[0];
    var areaSqm = L.GeometryUtil.geodesicArea(latlngs);
    var hectares = areaSqm / 10000;
    var acres = areaSqm / 4046.856;
    
    valueEl.textContent = hectares.toFixed(2) + " ha (" + acres.toFixed(2) + " acres)";
    display.classList.remove("hidden");
}

/* ==========================================
   SCORING HELPERS
   ========================================== */
function getScoreColor(score) {
    if (score > 0.6) return PRIMARY;
    if (score >= 0.3) return AMBER;
    return DANGER;
}

function getScoreClass(score) {
    if (score > 0.6) return "score-good";
    if (score >= 0.3) return "score-warn";
    return "score-bad";
}

function getSaviDotClass(score) {
    if (score === null || score === undefined) return "";
    if (score > 0.6) return "good";
    if (score >= 0.3) return "warn";
    return "bad";
}

function updateMeter(score) {
    var meter = document.getElementById("savi-meter");
    var progressSvg = document.getElementById("meter-progress");
    var valueEl = document.getElementById("meter-value");
    
    var clampedScore = Math.min(Math.max(score, 0), 1);
    var color = getScoreColor(clampedScore);

    if (progressSvg) {
        var dashoffset = 452.4 - (452.4 * clampedScore);
        progressSvg.style.strokeDashoffset = dashoffset;
        progressSvg.style.stroke = color;
    }

    meter.className = "savi-meter " + getScoreClass(clampedScore);
    valueEl.textContent = clampedScore.toFixed(2);
    valueEl.style.color = color;
}

function updateNdwi(ndwi) {
    var ndwiEl = document.getElementById("ndwi-value");
    if (ndwiEl) {
        ndwiEl.textContent = (typeof ndwi === 'number' && !isNaN(ndwi)) ? ndwi.toFixed(2) : "--";
        
        if (ndwi < -0.1) {
            ndwiEl.style.color = "#D32F2F"; // Danger - Dry
        } else if (ndwi < 0.2) {
            ndwiEl.style.color = "#FFC107"; // Warn - Moderate
        } else {
            ndwiEl.style.color = "#1976D2"; // Good - Wet
        }
    }
}

/* ==========================================
   10x10m GRID GENERATION & RENDERING
   ========================================== */

/**
 * Approximate meters per degree at a given latitude.
 * Used to create 10x10m grid cells as GeoJSON rectangles.
 */
function metersPerDegree(lat) {
    var latRad = lat * Math.PI / 180;
    var mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
    var mPerDegLng = 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad);
    return { lat: mPerDegLat, lng: mPerDegLng };
}

/**
 * Get SAVI fill color using strict agronomic scale.
 * Score >= 0.5: Deep Green (Healthy)
 * Score 0.3-0.49: Light Green/Yellow-Green (Slight Stress)
 * Score 0.1-0.29: Yellow/Orange (Moderate Stress)
 * Score < 0.1: Red (Severe Stress/Bare Soil)
 */
function getSaviFillColor(score) {
    if (score >= 0.5) return '#1B5E20';  // Deep Green
    if (score >= 0.3) return '#8BC34A';  // Yellow-Green
    if (score >= 0.1) return '#FF9800';  // Orange
    return '#D32F2F';                     // Red
}

/**
 * Get NDWI fill color using strict agronomic scale.
 * Score >= 0.2: Deep Blue (High Moisture)
 * Score 0.0-0.19: Light Blue/Cyan (Adequate Moisture)
 * Score -0.2 to -0.01: Yellow/Light Orange (Drying)
 * Score < -0.2: Deep Red (Severe Water Deficit)
 */
function getNdwiFillColor(score) {
    if (score >= 0.2) return '#0D47A1';   // Deep Blue
    if (score >= 0.0) return '#4DD0E1';   // Cyan
    if (score >= -0.2) return '#FFB74D';  // Light Orange
    return '#D32F2F';                      // Deep Red
}

/**
 * Get status text for a SAVI score.
 */
function getSaviStatus(score) {
    if (score >= 0.5) return 'Healthy';
    if (score >= 0.3) return 'Slight Stress';
    if (score >= 0.1) return 'Moderate Stress';
    return 'Severe Stress';
}

/**
 * Get status text for an NDWI score.
 */
function getNdwiStatus(score) {
    if (score >= 0.2) return 'High Moisture';
    if (score >= 0.0) return 'Adequate';
    if (score >= -0.2) return 'Drying';
    return 'Water Deficit';
}

/**
 * Check if a point is inside a polygon using ray-casting.
 */
function pointInPolygon(lat, lng, polygon) {
    var latlngs = polygon.getLatLngs()[0];
    var inside = false;
    for (var i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
        var xi = latlngs[i].lat, yi = latlngs[i].lng;
        var xj = latlngs[j].lat, yj = latlngs[j].lng;
        var intersect = ((yi > lng) !== (yj > lng)) &&
            (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Generate 10x10m grid cells within the polygon bounds.
 * Each cell gets a simulated SAVI and NDWI score based on
 * the mean + spatial variation (using deterministic noise
 * from position to ensure consistent values).
 */
function generateGridCells(polygon, meanSavi, meanNdwi) {
    var bounds = polygon.getBounds();
    var south = bounds.getSouth();
    var north = bounds.getNorth();
    var west = bounds.getWest();
    var east = bounds.getEast();
    var centerLat = (south + north) / 2;

    var mpd = metersPerDegree(centerLat);
    var cellSizeLat = 10 / mpd.lat; // 10m in degrees latitude
    var cellSizeLng = 10 / mpd.lng; // 10m in degrees longitude

    var cells = [];
    var cellIndex = 0;

    for (var lat = south; lat < north; lat += cellSizeLat) {
        for (var lng = west; lng < east; lng += cellSizeLng) {
            var cellCenterLat = lat + cellSizeLat / 2;
            var cellCenterLng = lng + cellSizeLng / 2;

            // Only include cells whose center falls inside the polygon
            if (!pointInPolygon(cellCenterLat, cellCenterLng, polygon)) {
                cellIndex++;
                continue;
            }

            // Deterministic spatial variation using a simple hash
            var hash = Math.sin(cellIndex * 127.1 + lat * 311.7) * 43758.5453;
            hash = hash - Math.floor(hash); // 0-1
            var variation = (hash - 0.5) * 0.3; // ±0.15 variation

            var cellSavi = Math.max(-0.5, Math.min(1.0, meanSavi + variation));
            var cellNdwi = Math.max(-1.0, Math.min(1.0, meanNdwi + variation * 0.8));

            cells.push({
                bounds: [
                    [lat, lng],
                    [lat + cellSizeLat, lng],
                    [lat + cellSizeLat, lng + cellSizeLng],
                    [lat, lng + cellSizeLng]
                ],
                savi: Math.round(cellSavi * 1000) / 1000,
                ndwi: Math.round(cellNdwi * 1000) / 1000,
                row: Math.floor((lat - south) / cellSizeLat),
                col: Math.floor((lng - west) / cellSizeLng)
            });

            cellIndex++;
        }
    }

    return cells;
}

/**
 * Render grid cells on the map as discrete vector polygons.
 * Uses the currently active layer (SAVI or NDWI) for coloring.
 */
function renderGridLayer() {
    if (!storedGridData || !storedGridData.cells || storedGridData.cells.length === 0) return;

    // Clear existing grid
    if (gridLayerGroup) {
        gridLayerGroup.clearLayers();
    }

    var cells = storedGridData.cells;
    var getColor = activeLayer === 'ndwi' ? getNdwiFillColor : getSaviFillColor;
    var scoreKey = activeLayer === 'ndwi' ? 'ndwi' : 'savi';

    for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var score = cell[scoreKey];
        var fillColor = getColor(score);

        var rect = L.polygon(cell.bounds, {
            weight: 1,
            color: 'rgba(255,255,255,0.3)',
            fillColor: fillColor,
            fillOpacity: 0.72,
            interactive: true,
            className: 'grid-cell'
        });

        // Store cell data on the layer for tooltip access
        rect._gridCell = cell;

        // Hover interaction
        rect.on('mouseover', function (e) {
            var gc = e.target._gridCell;
            e.target.setStyle({
                weight: 2,
                color: '#FFFFFF',
                fillOpacity: 0.9
            });
            showGridTooltip(gc);
        });

        rect.on('mouseout', function (e) {
            e.target.setStyle({
                weight: 1,
                color: 'rgba(255,255,255,0.3)',
                fillOpacity: 0.72
            });
            hideGridTooltip();
        });

        // Click interaction (mobile-friendly)
        rect.on('click', function (e) {
            var gc = e.target._gridCell;
            showGridTooltip(gc);
            // Auto-hide after 4 seconds
            if (gridTooltipTimeout) clearTimeout(gridTooltipTimeout);
            gridTooltipTimeout = setTimeout(hideGridTooltip, 4000);
        });

        gridLayerGroup.addLayer(rect);
    }

    // Update legend bar
    updateGridLegend();
}

/**
 * Show the grid cell tooltip with exact numerical scores.
 */
function showGridTooltip(cell) {
    var tooltip = document.getElementById('grid-tooltip');
    var titleEl = document.getElementById('grid-tooltip-title');
    var saviEl = document.getElementById('grid-tooltip-savi');
    var ndwiEl = document.getElementById('grid-tooltip-ndwi');
    var statusEl = document.getElementById('grid-tooltip-status');

    titleEl.textContent = 'Grid [' + cell.row + ', ' + cell.col + ']';
    saviEl.textContent = cell.savi.toFixed(3);
    ndwiEl.textContent = cell.ndwi.toFixed(3);

    var statusText, statusColor;
    if (activeLayer === 'savi') {
        statusText = getSaviStatus(cell.savi);
        statusColor = getSaviFillColor(cell.savi);
    } else {
        statusText = getNdwiStatus(cell.ndwi);
        statusColor = getNdwiFillColor(cell.ndwi);
    }
    statusEl.textContent = statusText;
    statusEl.style.color = statusColor;

    // Color-code the active index value
    if (activeLayer === 'savi') {
        saviEl.style.color = getSaviFillColor(cell.savi);
        ndwiEl.style.color = '#fff';
    } else {
        ndwiEl.style.color = getNdwiFillColor(cell.ndwi);
        saviEl.style.color = '#fff';
    }

    tooltip.classList.remove('hidden');
}

/**
 * Hide the grid cell tooltip.
 */
function hideGridTooltip() {
    var tooltip = document.getElementById('grid-tooltip');
    tooltip.classList.add('hidden');
}

/**
 * Create or update the gradient legend bar on the map.
 */
function updateGridLegend() {
    // Remove existing legend
    if (gridLegendEl && gridLegendEl.parentNode) {
        gridLegendEl.parentNode.removeChild(gridLegendEl);
    }

    gridLegendEl = document.createElement('div');
    gridLegendEl.className = 'grid-legend-bar';

    var isSavi = activeLayer === 'savi';
    gridLegendEl.innerHTML =
        '<div class="grid-legend-title">' + (isSavi ? 'SAVI — Vegetation Health' : 'NDWI — Water Stress') + '</div>' +
        '<div class="grid-legend-gradient ' + (isSavi ? 'savi-gradient' : 'ndwi-gradient') + '"></div>' +
        '<div class="grid-legend-labels">' +
            '<span>' + (isSavi ? 'Bare' : 'Deficit') + '</span>' +
            '<span>' + (isSavi ? 'Healthy' : 'Wet') + '</span>' +
        '</div>';

    var mapContainer = document.getElementById('map-container');
    mapContainer.appendChild(gridLegendEl);
}

/**
 * Remove the legend bar from the map.
 */
function removeGridLegend() {
    if (gridLegendEl && gridLegendEl.parentNode) {
        gridLegendEl.parentNode.removeChild(gridLegendEl);
        gridLegendEl = null;
    }
}

function updateAdvice(text, isError) {
    var container = document.getElementById("ai-response");
    container.innerHTML = "";
    container.classList.remove("active", "error");
    var p = document.createElement("p");
    p.className = "advice-text";
    p.textContent = text;
    container.appendChild(p);
    container.classList.add(isError ? "error" : "active");
}

function showError(message) {
    var errorDiv = document.getElementById("error-message");
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = "block";
    }
}

function hideError() {
    var errorDiv = document.getElementById("error-message");
    if (errorDiv) {
        errorDiv.textContent = "";
        errorDiv.style.display = "none";
    }
}

function setLoading(active) {
    var btn = document.getElementById("analyze-btn");
    var textEl = btn.querySelector(".btn-text");
    isProcessing = active;
    btn.disabled = active;
    if (active) {
        btn.classList.add("loading");
        textEl.textContent = "Processing Satellite Data...";
    } else {
        btn.classList.remove("loading");
        textEl.textContent = "Calculate SAVI";
    }
}

/* ==========================================
   ANALYZE HANDLER
   ========================================== */
function handleAnalyze(optionalCoords) {
    if (isProcessing) return;

    var coords;
    if (Array.isArray(optionalCoords)) {
        coords = optionalCoords;
    } else if (currentPolygon) {
        coords = extractCoordinates();
    } else {
        showToast("Please draw a field boundary on the map first.", "warn");
        shakeMeter();
        return;
    }

    if (coords.length < 3) {
        showToast("A valid polygon requires at least 3 vertices.", "warn");
        return;
    }

    var isDemoMode = document.getElementById("demo-toggle").checked;
    setLoading(true);
    hideError();

    // Reset UI state from previous analysis
    updateNdwi(null);
    var chartCont = document.getElementById("chart-container");
    if (chartCont) chartCont.style.display = "none";

    // Clear previous heatmap overlay
    if (saviLayer) {
        map.removeLayer(saviLayer);
        saviLayer = null;
    }
    // Clear previous grid
    if (gridLayerGroup) gridLayerGroup.clearLayers();
    storedGridData = null;
    removeGridLegend();
    hideGridTooltip();


    if (isDemoMode) {
        setTimeout(function () {
            updateMeter(0.88);
            updateNdwi(0.35);
            updateAdvice(
                "Crop health is optimal. The mesophyll layer shows strong NIR reflectance. No immediate intervention required.",
                false
            );
            setLoading(false);
            PlotManager._updateLastSavi(coords, 0.88);
            renderHistoryChart([0.85, 0.82, 0.88]);
            
            // Generate demo grid
            if (currentPolygon) {
                var demoCells = generateGridCells(currentPolygon, 0.88, 0.35);
                storedGridData = { cells: demoCells, meanSavi: 0.88, meanNdwi: 0.35 };
                renderGridLayer();
                map.fitBounds(currentPolygon.getBounds(), { padding: [50, 50] });
            }
        }, 500);
        return;
    }

    // AbortController with 60s timeout to prevent infinite loading
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
        controller.abort();
    }, 60000);

    fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coordinates: coords }),
        signal: controller.signal,
    })
        .then(function (res) {
            clearTimeout(timeoutId);
            if (!res.ok) {
                return res.text().then(function (body) {
                    var detail = "Server returned status " + res.status;
                    try {
                        var parsed = JSON.parse(body);
                        if (parsed.detail) {
                            detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
                        }
                    } catch (e) {
                        detail = body || detail;
                    }
                    throw new Error(detail);
                });
            }
            return res.json();
        })
        .then(function (data) {
            if (data.savi_score === 0 && data.gemini_advice) {
                updateMeter(0);
                updateNdwi(0);
                updateAdvice(data.gemini_advice, true);
            } else {
                updateMeter(data.savi_score);
                updateNdwi(data.ndwi_score);
                updateAdvice(data.gemini_advice, false);
                
                // Earth Engine Heatmap Overlay (kept as fallback / base layer)
                if (data.heatmap_url) {
                    saviLayer = L.tileLayer(data.heatmap_url, {
                        opacity: 0.35,
                        maxZoom: 19,
                    }).addTo(map);
                }

                // Generate 10x10m precision grid overlay
                if (currentPolygon) {
                    var gridCells = generateGridCells(currentPolygon, data.savi_score, data.ndwi_score);
                    storedGridData = { cells: gridCells, meanSavi: data.savi_score, meanNdwi: data.ndwi_score };
                    renderGridLayer();
                    map.fitBounds(currentPolygon.getBounds(), { padding: [50, 50] });
                }
            }
            PlotManager._updateLastSavi(coords, data.savi_score);
            if (data.savi_history && data.savi_history.length > 0) {
                renderHistoryChart(data.savi_history);
            }
        })
        .catch(function (err) {
            clearTimeout(timeoutId);
            var message = err.message || "Unknown error";
            if (err.name === "AbortError") {
                message = "Analysis timed out after 60 seconds. The satellite server may be slow \u2014 please try again or switch to Demo Mode.";
            } else if (message === "Failed to fetch" || message.indexOf("NetworkError") !== -1) {
                message = "Telemetry server unreachable. Please check your connection or switch to Demo Mode.";
            }
            updateAdvice(message, true);
            showError(message);
            showToast("Analysis failed. See details below.", "error");
        })
        .finally(function () {
            setLoading(false);
        });
}

var saviChartInstance = null;

function renderHistoryChart(historyData) {
    var container = document.getElementById("chart-container");
    if (!historyData || historyData.length === 0) {
        return;
    }
    
    // Reverse fetched [Today, -15, -30] to chronological order [-30, -15, Today]
    var dataChronological = [historyData[2], historyData[1], historyData[0]];
    
    container.style.display = "block";
    var ctx = document.getElementById("savi-history-chart").getContext("2d");
    
    if (saviChartInstance) {
        saviChartInstance.destroy();
    }
    
    saviChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['-30 Days', '-15 Days', 'Today'],
            datasets: [{
                label: 'SAVI Trend',
                data: dataChronological,
                borderColor: '#1B5E20',
                backgroundColor: 'rgba(27, 94, 32, 0.1)',
                tension: 0.3,
                fill: true,
                pointRadius: 4,
                pointBackgroundColor: '#43A047'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    min: 0,
                    max: 1,
                    ticks: { stepSize: 0.2 }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function handleDownloadPdf() {
    var panel = document.getElementById('pulse-panel');
    var btn = document.getElementById("download-pdf-btn");
    var svgOriginal = btn.innerHTML;
    
    var opt = {
      margin:       0.3,
      filename:     'Auraphyll_Report.pdf',
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true, scrollY: 0 },
      jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
    
    btn.innerHTML = "...";
    btn.disabled = true;
    
    var originalTransform = panel.style.transform;
    var originalOverflow = panel.style.overflow;
    panel.style.transform = 'none';
    panel.style.overflow = 'visible';
    
    html2pdf().set(opt).from(panel).save().then(function() {
        panel.style.transform = originalTransform;
        panel.style.overflow = originalOverflow;
        btn.innerHTML = svgOriginal;
        btn.disabled = false;
        showToast("PDF Report Downloaded", "success", 2000);
    }).catch(function(err) {
        panel.style.transform = originalTransform;
        panel.style.overflow = originalOverflow;
        btn.innerHTML = svgOriginal;
        btn.disabled = false;
        showToast("PDF Generation Failed", "error", 2000);
    });
}

function shakeMeter() {
    var meter = document.getElementById("savi-meter");
    meter.style.animation = "none";
    meter.offsetHeight;
    meter.style.animation = "shake 0.4s ease-in-out";
    setTimeout(function () {
        meter.style.animation = "";
    }, 500);
}

/* ==========================================
   ALU PLOT MANAGER
   ========================================== */
var PlotManager = {
    plots: [],
    _recallingCoords: null,

    init: function () {
        this.plots = this._load();
        this._renderList();
        this._drawAllOnMap();
    },

    _load: function () {
        try {
            var data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    },

    _save: function () {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.plots));
        } catch (e) {
            showToast("Failed to save plots to local storage.", "error");
        }
    },

    _updateBadge: function () {
        var badge = document.getElementById("plot-count-badge");
        badge.textContent = this.plots.length;
        if (this.plots.length > 0) {
            badge.classList.remove("empty");
        } else {
            badge.classList.add("empty");
        }
    },

    _renderList: function () {
        var list = document.getElementById("plot-list");
        list.innerHTML = "";
        this._updateBadge();

        if (this.plots.length === 0) {
            var empty = document.createElement("li");
            empty.className = "plot-empty-state";
            empty.id = "plot-empty-state";
            empty.innerHTML =
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"/></svg>' +
                "<span>Draw a polygon and save it to create your first plot.</span>";
            list.appendChild(empty);
            return;
        }

        for (var i = 0; i < this.plots.length; i++) {
            list.appendChild(this._createListItem(this.plots[i]));
        }
    },

    _createListItem: function (plot) {
        var li = document.createElement("li");
        li.className = "plot-item";
        li.setAttribute("data-plot-id", plot.id);

        // SAVI dot
        var dot = document.createElement("span");
        dot.className = "plot-savi-dot";
        if (plot.lastSavi !== null && plot.lastSavi !== undefined) {
            dot.classList.add(getSaviDotClass(plot.lastSavi));
        }

        // Info
        var info = document.createElement("div");
        info.className = "plot-info";

        var name = document.createElement("div");
        name.className = "plot-name";
        name.textContent = plot.name;

        var meta = document.createElement("div");
        meta.className = "plot-meta";

        var dateSpan = document.createElement("span");
        var d = new Date(plot.createdAt);
        dateSpan.textContent = d.toLocaleDateString();

        meta.appendChild(dateSpan);

        if (plot.lastSavi !== null && plot.lastSavi !== undefined) {
            var sep = document.createElement("span");
            sep.className = "plot-meta-sep";
            meta.appendChild(sep);

            var saviSpan = document.createElement("span");
            saviSpan.textContent = "SAVI: " + plot.lastSavi.toFixed(2);
            meta.appendChild(saviSpan);
        }

        info.appendChild(name);
        info.appendChild(meta);

        // Delete button
        var delBtn = document.createElement("button");
        delBtn.className = "plot-delete-btn";
        delBtn.title = "Delete plot";
        delBtn.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>';

        // Visibility Toggle
        var visBtn = document.createElement("button");
        visBtn.className = "plot-visibility-btn";
        if (plot.hidden) visBtn.classList.add("hidden-plot");
        visBtn.title = "Toggle visibility on map";
        visBtn.innerHTML = plot.hidden ?
            '<svg viewBox="0 0 24 24" fill="none"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" fill="currentColor"/></svg>'
            :
            '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" fill="currentColor"/></svg>';

        var self = this;
        var plotId = plot.id;

        // Click item → recall
        li.addEventListener("click", function (e) {
            if (e.target.closest(".plot-delete-btn") || e.target.closest(".plot-visibility-btn")) return;
            self.recallPlot(plotId);
        });

        // Click delete
        delBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            self.deletePlot(plotId);
        });

        // Click visibility
        visBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            self.toggleVisibility(plotId);
        });

        li.appendChild(dot);
        li.appendChild(info);
        li.appendChild(visBtn);
        li.appendChild(delBtn);

        return li;
    },

    savePlot: function (name, coordinates) {
        var plot = {
            id: "alu_" + Date.now(),
            name: name,
            coordinates: coordinates,
            createdAt: new Date().toISOString(),
            lastSavi: null,
        };

        this.plots.push(plot);
        this._save();
        this._renderList();
        this._drawPlotOnMap(plot);
        showToast('Plot "' + name + '" saved successfully.', "success", 2500);
    },

    deletePlot: function (id) {
        var idx = -1;
        for (var i = 0; i < this.plots.length; i++) {
            if (this.plots[i].id === id) {
                idx = i;
                break;
            }
        }
        if (idx === -1) return;

        var removed = this.plots.splice(idx, 1)[0];
        this._save();
        this._renderList();

        // Remove from map
        savedPlotsLayerGroup.eachLayer(function (layer) {
            if (layer._plotId === id) {
                savedPlotsLayerGroup.removeLayer(layer);
            }
        });

        showToast('Plot "' + removed.name + '" deleted.', "info", 2500);
    },

    toggleVisibility: function (id) {
        var plot = null;
        for (var i = 0; i < this.plots.length; i++) {
            if (this.plots[i].id === id) {
                plot = this.plots[i];
                break;
            }
        }
        if (!plot) return;

        plot.hidden = !plot.hidden;
        this._save();
        this._renderList();

        var tgtLayer = null;
        savedPlotsLayerGroup.eachLayer(function (layer) {
            if (layer._plotId === id) {
                tgtLayer = layer;
            }
        });

        if (plot.hidden && tgtLayer) {
            savedPlotsLayerGroup.removeLayer(tgtLayer);
        } else if (!plot.hidden && !tgtLayer) {
            this._drawPlotOnMap(plot);
        }
    },

    recallPlot: function (id) {
        var plot = null;
        for (var i = 0; i < this.plots.length; i++) {
            if (this.plots[i].id === id) {
                plot = this.plots[i];
                break;
            }
        }
        if (!plot) return;

        // Build latlngs
        var latlngs = [];
        for (var j = 0; j < plot.coordinates.length; j++) {
            latlngs.push([plot.coordinates[j].lat, plot.coordinates[j].lng]);
        }

        // Fit map to plot bounds
        var tempPoly = L.polygon(latlngs);
        map.fitBounds(tempPoly.getBounds(), { padding: [40, 40] });

        // Set as current polygon for analysis
        if (currentPolygon) {
            drawnItems.removeLayer(currentPolygon);
        }
        
        // Break out of any active drawing tool to reset state properly
        if (drawControl && drawControl._toolbars) {
            for (var toolbarId in drawControl._toolbars) {
                drawControl._toolbars[toolbarId].disable();
            }
        }

        currentPolygon = L.polygon(latlngs, {
            color: "#43A047",
            weight: 2.5,
            opacity: 0.9,
            fillColor: "#1B5E20",
            fillOpacity: 0.18,
        });
        drawnItems.addLayer(currentPolygon);
        updateSaveBtnState();
        updateAreaDisplay(currentPolygon);

        // Store coords for SAVI update tracking
        this._recallingCoords = plot.coordinates;

        // Auto-trigger analysis
        showToast('Analyzing plot "' + plot.name + '"...', "info", 2000);
        setTimeout(function () {
            handleAnalyze(plot.coordinates);
        }, 500);
    },

    _drawPlotOnMap: function (plot) {
        var latlngs = [];
        for (var i = 0; i < plot.coordinates.length; i++) {
            latlngs.push([plot.coordinates[i].lat, plot.coordinates[i].lng]);
        }

        var polygon = L.polygon(latlngs, {
            color: "#66BB6A",
            weight: 2,
            opacity: 0.7,
            dashArray: "8, 6",
            fillColor: "#1B5E20",
            fillOpacity: 0.08,
            interactive: true,
        });

        polygon._plotId = plot.id;
        polygon.bindTooltip(plot.name, {
            permanent: false,
            direction: "center",
            className: "plot-tooltip",
        });

        savedPlotsLayerGroup.addLayer(polygon);
    },

    _drawAllOnMap: function () {
        savedPlotsLayerGroup.clearLayers();
        for (var i = 0; i < this.plots.length; i++) {
            if (!this.plots[i].hidden) {
                this._drawPlotOnMap(this.plots[i]);
            }
        }
    },

    _updateLastSavi: function (coords, savi) {
        // Find the matching plot by coordinate comparison
        var found = false;
        for (var i = 0; i < this.plots.length; i++) {
            var p = this.plots[i];
            if (this._coordsMatch(p.coordinates, coords)) {
                p.lastSavi = savi;
                found = true;
                break;
            }
        }
        if (found) {
            this._save();
            this._renderList();
        }
    },

    _coordsMatch: function (a, b) {
        if (!a || !b || a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
            if (Math.abs(a[i].lat - b[i].lat) > 0.00001 || Math.abs(a[i].lng - b[i].lng) > 0.00001) {
                return false;
            }
        }
        return true;
    },
};

/* ==========================================
   SAVE PLOT HANDLER
   ========================================== */
function handleSavePlot() {
    if (!currentPolygon) {
        showToast("Draw a field polygon first.", "warn");
        return;
    }

    var name = prompt("Enter a name for this plot (e.g., 'North Paddy Block'):");
    if (!name || !name.trim()) {
        showToast("Plot name is required.", "warn");
        return;
    }

    name = name.trim();

    // Check uniqueness
    for (var i = 0; i < PlotManager.plots.length; i++) {
        if (PlotManager.plots[i].name.toLowerCase() === name.toLowerCase()) {
            showToast('A plot named "' + name + '" already exists.', "warn");
            return;
        }
    }

    var coords = extractCoordinates();
    PlotManager.savePlot(name, coords);
}

/* ==========================================
   WINDOW RESIZE — Immediate map invalidation (RAF)
   Complements the delayed invalidateSize in initMap.
   ========================================== */
var resizeRafTimer;
window.addEventListener("resize", function () {
    if (resizeRafTimer) window.cancelAnimationFrame(resizeRafTimer);
    resizeRafTimer = window.requestAnimationFrame(function () {
        if (map) map.invalidateSize();
    });
});

/* ==========================================
   INIT
   ========================================== */
document.addEventListener("DOMContentLoaded", initMap);
