import datetime
import time
import requests
from typing import List

import ee
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

# ==========================================
# 1. CREDENTIALS & CONFIGURATION
# ==========================================
GEMINI_API_KEY = "AIzaSyDao42z43m2flAvu-tZKwQkumdI1-roCC8"
GEE_PROJECT_ID = "964783763584"

try:
    ee.Initialize(project=GEE_PROJECT_ID)
    print("[OK] Earth Engine Initialized Successfully")
except Exception as e:
    print(f"[WARN] CRITICAL: Earth Engine failed to initialize. Error: {e}")

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

CLOUD_FALLBACK = AnalyzeResponse(
    savi_score=0.0,
    gemini_advice="Satellite telemetry currently obscured by dense cloud cover. Please rely on ground-based visual inspection.",
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
        return None, buffered_polygon

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
        return None, buffered_polygon
    savi_key = list(savi_value.keys())[0]
    result = savi_value[savi_key]
    if result is None:
        return None, buffered_polygon
    return result, buffered_polygon

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
    
    for model in GEMINI_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}"
        
        # Retry up to 3 times per model with exponential backoff
        for attempt in range(3):
            try:
                response = requests.post(
                    url,
                    headers={"Content-Type": "application/json"},
                    json=data,
                    timeout=25,
                )
                
                if response.status_code == 200:
                    text = _extract_text_from_response(response.json())
                    print(f"  [OK] Gemini advice generated via {model} (attempt {attempt + 1})")
                    return text
                
                # Retryable errors: 429 (rate limit), 503 (overloaded)
                if response.status_code in (429, 503):
                    wait = (2 ** attempt) + 0.5
                    print(f"  [WAIT] {model} returned {response.status_code}, retrying in {wait:.1f}s (attempt {attempt + 1}/3)")
                    time.sleep(wait)
                    last_error = f"{model} HTTP {response.status_code}"
                    continue
                
                # Non-retryable error
                last_error = f"{model} HTTP {response.status_code}: {response.text[:200]}"
                print(f"  [WARN] {last_error}")
                break  # Try next model
                
            except requests.exceptions.Timeout:
                last_error = f"{model} request timed out (attempt {attempt + 1})"
                print(f"  [WAIT] {last_error}")
                continue
            except Exception as e:
                last_error = f"{model} error: {repr(e)}"
                print(f"  [WARN] {last_error}")
                break  # Try next model
    
    raise Exception(f"All Gemini models failed. Last error: {last_error}")
# ==========================================
# 6. API ENDPOINT
# ==========================================
@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze(payload: AnalyzeRequest):
    coords_list = [[c.lng, c.lat] for c in payload.coordinates]

    # Step A: Get Satellite Data
    try:
        raw_score, _ = compute_savi(coords_list)
    except Exception as e:
        print(f"[WARN] Earth Engine Error: {e}")
        return CLOUD_FALLBACK

    if raw_score is None:
        print("[WARN] Earth Engine returned no valid images (likely too cloudy).")
        return CLOUD_FALLBACK

    mean_savi_score = round(float(raw_score), 4)
    print(f"[OK] SAVI Calculated: {mean_savi_score}")

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
    return AnalyzeResponse(savi_score=mean_savi_score, gemini_advice=advice_text)