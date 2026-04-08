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

var PRIMARY = "#1B5E20";
var AMBER = "#FFC107";
var DANGER = "#D32F2F";
var BORDER_COLOR = "#E5E7EB";
var API_URL = "http://127.0.0.1:8000/api/analyze";

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

        if (!this._isMobile()) return;

        this.sheetHeight = this.panel.offsetHeight;
        this.peekH = 88;

        this.handle.addEventListener("touchstart", this._onTouchStart.bind(this), { passive: true });
        this.handle.addEventListener("touchmove", this._onTouchMove.bind(this), { passive: false });
        this.handle.addEventListener("touchend", this._onTouchEnd.bind(this), { passive: true });

        // Also allow tapping handle to toggle
        this.handle.addEventListener("click", this._onHandleClick.bind(this));
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
        var deltaY = e.touches[0].clientY - this.startY;
        var newTranslate = this.startTranslate + deltaY;

        // Clamp: can't go above full (0) or below peek
        var maxTranslate = this._getTranslateForState("peek");
        newTranslate = Math.max(0, Math.min(newTranslate, maxTranslate));

        this.currentTranslate = newTranslate;
        this.panel.style.transform = "translateY(" + newTranslate + "px)";
    },

    _onTouchEnd: function () {
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

    _onHandleClick: function () {
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
    });

    document.getElementById("analyze-btn").addEventListener("click", handleAnalyze);
    document.getElementById("demo-toggle").addEventListener("change", function () {
        var label = document.getElementById("mode-label-text");
        label.textContent = this.checked ? "Demo Mode" : "Live Mode";
    });

    // Save plot button
    document.getElementById("save-plot-btn").addEventListener("click", handleSavePlot);

    // Plot manager toggle
    document.getElementById("plot-manager-toggle").addEventListener("click", function () {
        var pm = document.getElementById("plot-manager");
        pm.classList.toggle("collapsed");
    });

    // Initialize bottom sheet (mobile only)
    BottomSheet.init();

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
    var valueEl = document.getElementById("meter-value");
    var percent = Math.min(Math.max(score, 0), 1) * 100;
    var color = getScoreColor(score);

    meter.style.background =
        "conic-gradient(" + color + " 0% " + percent + "%, " + BORDER_COLOR + " " + percent + "% 100%)";
    meter.className = "savi-meter " + getScoreClass(score);
    valueEl.textContent = score.toFixed(2);
    valueEl.style.color = color;
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

function setLoading(active) {
    var btn = document.getElementById("analyze-btn");
    var textEl = btn.querySelector(".btn-text");
    isProcessing = active;
    btn.disabled = active;
    if (active) {
        btn.classList.add("loading");
        textEl.textContent = "Analyzing\u2026";
    } else {
        btn.classList.remove("loading");
        textEl.textContent = "Analyze Field";
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

    // On mobile, open the sheet to show results
    BottomSheet.snapToHalf();

    if (isDemoMode) {
        setTimeout(function () {
            updateMeter(0.88);
            updateAdvice(
                "Crop health is optimal. The mesophyll layer shows strong NIR reflectance. No immediate intervention required.",
                false
            );
            setLoading(false);
            // Update saved plot's lastSavi if this was a recall
            PlotManager._updateLastSavi(coords, 0.88);
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
                updateAdvice(data.gemini_advice, true);
            } else {
                updateMeter(data.savi_score);
                updateAdvice(data.gemini_advice, false);
            }
            setLoading(false);
            PlotManager._updateLastSavi(coords, data.savi_score);
        })
        .catch(function (err) {
            clearTimeout(timeoutId);
            var message = err.message || "Unknown error";
            if (err.name === "AbortError") {
                message = "Analysis timed out after 60 seconds. The satellite server may be slow — please try again or switch to Demo Mode.";
            } else if (message === "Failed to fetch" || message.indexOf("NetworkError") !== -1) {
                message = "Telemetry server unreachable. Please check your connection or switch to Demo Mode.";
            }
            updateAdvice(message, true);
            showToast("Analysis failed. See details below.", "error");
            setLoading(false);
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

        var self = this;
        var plotId = plot.id;

        // Click item → recall
        li.addEventListener("click", function (e) {
            if (e.target.closest(".plot-delete-btn")) return;
            self.recallPlot(plotId);
        });

        // Click delete
        delBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            self.deletePlot(plotId);
        });

        li.appendChild(dot);
        li.appendChild(info);
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
        currentPolygon = L.polygon(latlngs, {
            color: "#43A047",
            weight: 2.5,
            opacity: 0.9,
            fillColor: "#1B5E20",
            fillOpacity: 0.18,
        });
        drawnItems.addLayer(currentPolygon);
        updateSaveBtnState();

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
            this._drawPlotOnMap(this.plots[i]);
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
   WINDOW RESIZE — Re-init bottom sheet
   ========================================== */
var resizeTimer;
window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
        if (map) map.invalidateSize();
    }, 200);
});

/* ==========================================
   INIT
   ========================================== */
document.addEventListener("DOMContentLoaded", initMap);
