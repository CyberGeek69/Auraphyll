import os
import datetime
import time
import requests
from typing import List
import json
from google.oauth2 import service_account

import ee
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from dotenv import load_dotenv

load_dotenv()

# ==========================================
# 0. PATH CONFIGURATION
# ==========================================
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# ==========================================
# 1. CREDENTIALS & CONFIGURATION
# ==========================================
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEE_PROJECT_ID = os.getenv("GEE_PROJECT_ID")

if GEMINI_API_KEY is None or GEE_PROJECT_ID is None:
    print("[WARN] CRITICAL: Missing GEMINI_API_KEY or GEE_PROJECT_ID in environment variables.")

try:
    # Fetch credentials from environment
    ee_service_account = os.environ.get('EE_SERVICE_ACCOUNT_JSON')
    gee_project = os.environ.get('GEE_PROJECT_ID', 'auraphyll-mvp')

    if ee_service_account:
        # Railway Cloud Deployment Route
        credentials_dict = json.loads(ee_service_account)
        
        # Define scopes explicitly during creation to prevent OAuth formatting bugs
        SCOPES = [
            'https://www.googleapis.com/auth/earthengine',
            'https://www.googleapis.com/auth/cloud-platform'
        ]
        creds = service_account.Credentials.from_service_account_info(credentials_dict, scopes=SCOPES)
        
        # Initialize using the fully scoped credentials
        ee.Initialize(credentials=creds, project=gee_project)
        print("Earth Engine Initialized via Service Account JSON with explicit scopes.")
    else:
        # Local Development Fallback Route
        ee.Initialize(project=gee_project)
        print("Earth Engine Initialized via default local credentials.")
except Exception as e:
    print(f"CRITICAL: Earth Engine failed to initialize: {e}")

# ==========================================
# 2. FASTAPI SETUP
# ==========================================
app = FastAPI(title="Auraphyll API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# 2.5 FRONTEND SERVING
# ==========================================
@app.get("/")
async def serve_frontend():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

# Mount the rest of the frontend files
app.mount("/static", StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")), name="static")


# ==========================================
# 3. DATA MODELS
# ==========================================
class Coordinate(BaseModel):
    lat: float
    lng: float

class AnalyzeRequest(BaseModel):
    coordinates: List[Coordinate]

    @field_validator("coordinates")
    @classmethod
    def validate_min_coordinates(cls, v):
        if len(v) < 3:
            raise ValueError("A polygon requires at least 3 coordinate vertices.")
        return v

class AnalyzeResponse(BaseModel):
    savi_score: float
    gemini_advice: str
    ndwi_score: float = 0.0
    heatmap_url: str = ""
    savi_history: List[float] = []

CLOUD_FALLBACK = AnalyzeResponse(
    savi_score=0.0,
    gemini_advice="Satellite telemetry currently obscured by dense cloud cover. Please rely on ground-based visual inspection.",
    ndwi_score=0.0,
    heatmap_url="",
    savi_history=[]
)

# ==========================================
# 4. CORE LOGIC: EARTH ENGINE (SAVI)
# ==========================================
def compute_savi(coords_list):
    polygon = ee.Geometry.Polygon([coords_list])
    buffered_polygon = polygon.buffer(-5)

    end_date = datetime.datetime.utcnow()
    start_date = end_date - datetime.timedelta(days=30)

    collection = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(buffered_polygon)
        .filterDate(start_date.strftime("%Y-%m-%d"), end_date.strftime("%Y-%m-%d"))
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
        .sort("CLOUDY_PIXEL_PERCENTAGE")
    )

    count = collection.size().getInfo()
    if count == 0:
        return None, 0.0, "", buffered_polygon

    best_image = ee.Image(collection.first())

    scl = best_image.select("SCL")
    cloud_mask = scl.neq(8).And(scl.neq(9)).And(scl.neq(3))
    masked_image = best_image.updateMask(cloud_mask)

    # SAVI formula with L=0.5 for soil/compost background noise reduction
    savi = masked_image.expression(
        "((NIR - RED) / (NIR + RED + L)) * (1 + L)",
        {
            "NIR": masked_image.select("B8"),
            "RED": masked_image.select("B4"),
            "L": 0.5,
        },
    )

    mean_savi = savi.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=buffered_polygon,
        scale=10,
        maxPixels=1e9,
    )

    savi_value = mean_savi.getInfo()
    if not savi_value:
        return None, 0.0, "", buffered_polygon
    savi_key = list(savi_value.keys())[0]
    result = savi_value[savi_key]
    if result is None:
        return None, 0.0, "", buffered_polygon

    # Calculate NDWI using B3 (Green) and B8 (NIR)
    ndwi = masked_image.normalizedDifference(['B3', 'B8']).rename('NDWI')
    mean_ndwi = ndwi.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=buffered_polygon,
        scale=10,
        maxPixels=1e9,
    )
    ndwi_value = mean_ndwi.getInfo()
    ndwi_result = ndwi_value.get('NDWI', 0.0) if ndwi_value else 0.0
    if ndwi_result is None:
        ndwi_result = 0.0

    # Generate Heatmap URLs using SAVI
    map_id_dict = savi.getMapId({
        'min': 0.0,
        'max': 1.0,
        'palette': ['#d73027', '#fdae61', '#a6d96a', '#1a9850']
    })
    heatmap_url = map_id_dict['tile_fetcher'].url_format if 'tile_fetcher' in map_id_dict else ""

    return result, ndwi_result, heatmap_url, buffered_polygon

def compute_savi_history(coords_list):
    polygon = ee.Geometry.Polygon([coords_list])
    buffered_polygon = polygon.buffer(-5)
    
    today = datetime.datetime.utcnow()
    dates = [today, today - datetime.timedelta(days=15), today - datetime.timedelta(days=30)]
    
    history = []
    for d in dates:
        start_date = d - datetime.timedelta(days=7)
        end_date = d + datetime.timedelta(days=1)
        
        collection = (
            ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
            .filterBounds(buffered_polygon)
            .filterDate(start_date.strftime("%Y-%m-%d"), end_date.strftime("%Y-%m-%d"))
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
            .sort("CLOUDY_PIXEL_PERCENTAGE")
        )
        
        try:
            count = collection.size().getInfo()
            if count == 0:
                history.append(0.0)
                continue
                
            best_image = ee.Image(collection.first())
            scl = best_image.select("SCL")
            cloud_mask = scl.neq(8).And(scl.neq(9)).And(scl.neq(3))
            masked_image = best_image.updateMask(cloud_mask)
            
            savi = masked_image.expression(
                "((NIR - RED) / (NIR + RED + L)) * (1 + L)",
                {
                    "NIR": masked_image.select("B8"),
                    "RED": masked_image.select("B4"),
                    "L": 0.5,
                },
            )
            
            mean_savi = savi.reduceRegion(
                reducer=ee.Reducer.mean(),
                geometry=buffered_polygon,
                scale=10,
                maxPixels=1e9,
            )
            
            val = mean_savi.getInfo()
            if val is not None and list(val.values())[0] is not None:
                history.append(round(float(list(val.values())[0]), 4))
            else:
                history.append(0.0)
        except Exception:
            history.append(0.0)
            
    return history

# ==========================================
# 5. CORE LOGIC: GEMINI AI (DIRECT API BYPASS)
# ==========================================
GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.0-flash-lite",
]

def _extract_text_from_response(response_json):
    """Extract text from Gemini response, handling thinking model multi-part output."""
    candidates = response_json.get("candidates", [])
    if not candidates:
        raise Exception("No candidates in Gemini response")
    
    parts = candidates[0].get("content", {}).get("parts", [])
    if not parts:
        raise Exception("No parts in Gemini response")
    
    # Thinking models return [thought_part, text_part] — grab the LAST text part
    text_parts = [p["text"] for p in parts if "text" in p]
    if not text_parts:
        raise Exception("No text parts in Gemini response")
    
    return text_parts[-1].strip()


def generate_advice(mean_savi_score):
    prompt = (
        f"You are Auraphyll, an expert agronomist in India. "
        f"The current Soil Adjusted Vegetation Index (SAVI) score of this field is {mean_savi_score} (Scale is 0 to 1). "
        f"Provide a concise, 2-sentence actionable warning or confirmation to the farmer."
    )
    
    data = {
        "contents": [{"parts": [{"text": prompt}]}]
    }
    
    last_error = None
    MAX_RETRIES = 3
    
    for i, model in enumerate(GEMINI_MODELS):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}"
        
        for attempt in range(MAX_RETRIES):
            try:
                response = requests.post(
                    url,
                    headers={"Content-Type": "application/json"},
                    json=data,
                    timeout=25,
                )
                
                if response.status_code == 200:
                    text = _extract_text_from_response(response.json())
                    print(f"  [OK] Gemini advice generated via {model}")
                    return text
                
                if response.status_code in (429, 500, 502, 503):
                    last_error = f"{model} HTTP {response.status_code}"
                    print(f"  [WARN] {last_error}. Attempt {attempt + 1}/{MAX_RETRIES}.")
                    if attempt < MAX_RETRIES - 1:
                        sleep_time = (attempt + 1) * 3
                        print(f"  [WAIT] Sleeping {sleep_time} seconds before retry...")
                        time.sleep(sleep_time)
                    continue
                
                # Non-retryable error
                last_error = f"{model} HTTP {response.status_code}: {response.text[:200]}"
                print(f"  [WARN] {last_error}")
                break # Break out of attempt loop, proceed to next model
                
            except requests.exceptions.Timeout:
                last_error = f"{model} request timed out"
                print(f"  [WARN] {last_error}. Attempt {attempt + 1}/{MAX_RETRIES}.")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(3)
                continue
            except Exception as e:
                last_error = f"{model} error: {repr(e)}"
                print(f"  [WARN] {last_error}")
                break # Break out of attempt loop, proceed to next model
    
    raise Exception(f"All Gemini models failed. Last error: {last_error}")
# ==========================================
# 6. API ENDPOINT
# ==========================================
@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze(payload: AnalyzeRequest):
    coords_list = [[c.lng, c.lat] for c in payload.coordinates]

    # Step A: Get Satellite Data
    try:
        raw_score, ndwi_score, heatmap_url, _ = compute_savi(coords_list)
        savi_history = compute_savi_history(coords_list)
    except Exception as e:
        print(f"[WARN] Earth Engine Error: {e}")
        return CLOUD_FALLBACK

    if raw_score is None:
        print("[WARN] Earth Engine returned no valid images (likely too cloudy).")
        return CLOUD_FALLBACK

    mean_savi_score = round(float(raw_score), 4)
    ndwi_score_rounded = round(float(ndwi_score), 4)
    print(f"[OK] SAVI Calculated: {mean_savi_score}, NDWI: {ndwi_score_rounded}")

    # Step B: Get AI Agronomist Advice
    try:
        advice_text = generate_advice(mean_savi_score)
        print("[OK] Gemini AI Advice Generated")
    except Exception as e:
        print(f"[WARN] Gemini API Error: {repr(e)}")
        advice_text = (
            f"SAVI score is {mean_savi_score}. AI advisory is temporarily unavailable. "
            f"Please consult local agronomic guidelines."
        )

    # Step C: Send everything back to the Leaflet Frontend
    return AnalyzeResponse(
        savi_score=mean_savi_score, 
        gemini_advice=advice_text,
        ndwi_score=ndwi_score_rounded,
        heatmap_url=heatmap_url,
        savi_history=savi_history
    )