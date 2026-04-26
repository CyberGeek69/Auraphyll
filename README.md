# Auraphyll 🌿

**Auraphyll** is a precision agriculture early warning system that utilizes satellite telemetry and AI-driven agronomic advice. Designed as a "Smart Resource Allocation" platform, it tackles the world's most pressing food challenges by empowering smallholder farmers and agribusinesses with hyper-local insight.

---

## 🎯 Sustainable Development Goals (SDGs)

Auraphyll directly aligns with the United Nations Sustainable Development Goals:

- **SDG 2: Zero Hunger** 🌾
  By monitoring crop health via the Soil Adjusted Vegetation Index (SAVI) and Normalized Difference Water Index (NDWI), Auraphyll identifies crop stress weeks before it becomes visible to the naked eye. This proactive approach prevents yield loss and enhances food security.

- **SDG 12: Responsible Consumption and Production** 💧
  We enable Smart Resource Allocation. By pinpointing exactly which parts of a field are experiencing water deficiency or nutrient stress, farmers can drastically reduce the overuse of fertilizers and water—promoting sustainable agricultural practices and reducing ecological footprints.

## 🚀 Features

- **Live Sentinel-2 Telemetry:** Real-time fetching of multispectral satellite imagery using Google Earth Engine.
- **SAVI & NDWI Generation:** Robust vegetation and water stress indices calculated on-the-fly and displayed as an interactive heatmap.
- **AI Agronomist:** Gemini 2.0 powers immediate, actionable agronomic advice directly correlated with the precise SAVI index.
- **1-Click PDF Reports:** Seamlessly generate offline-ready agricultural unit reports.
- **Mobile-First App:** Engineered for the field. High-contrast UI, large touch targets, and a tactile bottom-sheet interaction ensure usability under direct sunlight.

## 🛠️ Architecture

Auraphyll's architecture is a lightweight, scalable full-stack application setup:
- **Frontend:** HTML5, CSS3, Vanilla JS, and Leaflet.js
- **Backend:** Python + FastAPI
- **Cloud & AI:** Google Earth Engine (GEE), Google Gemini AI API
- **Deployment:** Nixpacks on Railway (via `railway.json` + `requirements.txt`)

## ⚙️ Quick Start

### 1. Prerequisites
- Python 3.10+
- A Google Cloud Project with the Earth Engine API enabled.
- A Gemini AI API Key.

### 2. Environment Setup
Create a `.env` file in the `backend/` directory:
```env
GEMINI_API_KEY=your_gemini_api_key_here
GEE_PROJECT_ID=your_gee_project_id_here
```

### 3. Run Locally

**Backend Server:**
Navigate to `Auraphyll_Web_MVP/backend` and run:
```bash
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**Frontend:**
Serve the `Auraphyll_Web_MVP` directory with any static server:
```bash
python -m http.server 3000
```
Open `http://localhost:3000` in your browser.

## 🌍 Impact
*Empowering every farmer with the spatial intelligence needed to feed the future efficiently.*
