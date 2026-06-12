from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

import json
import sys
from pathlib import Path
from pydantic import BaseModel
import paho.mqtt.client as mqtt
import threading

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

app = FastAPI()

# -----------------------------
# MQTT 설정
# -----------------------------
MQTT_BROKER = "localhost" 
MQTT_PORT = 1883
MQTT_TOPIC = "test/topic"

# 최신 데이터 저장소 (in-memory)
mqtt_data_store = {}

# -----------------------------
# MQTT 콜백
# -----------------------------
def mqtt_on_connect(client, userdata, flags, rc):
    print("MQTT Connected:", rc)
    
    client.subscribe(MQTT_TOPIC)
pass # mqtt_on_connect

def mqtt_on_message(client, userdata, msg):
    payload = msg.payload.decode()
    
    print(f"Received: {msg.topic} -> {payload}")

    try:
        mqtt_data_store[msg.topic] = json.loads(payload)
    except:
        mqtt_data_store[msg.topic] = payload
    pass
pass # mqtt_on_message

# -----------------------------
# MQTT 클라이언트 시작
# -----------------------------
def start_mqtt_runnable():
    client = mqtt.Client()
    client.on_connect = mqtt_on_connect
    client.on_message = mqtt_on_message

    client.connect(MQTT_BROKER, MQTT_PORT, 60)
    client.loop_forever()
pass # start_mqtt_runnable

# 백그라운드 스레드 실행
threading.Thread(target=start_mqtt_runnable, daemon=True).start() 

# -----------------------------
# API 모델
# -----------------------------
class PublishModel(BaseModel) :
    topic: str
    message: dict
pass # PublishModel

# -----------------------------
# API - publish
# -----------------------------
@app.post("/fast/mqtt/publish")
def publish(data: PublishModel):
    client = mqtt.Client()
    client.connect(MQTT_BROKER, MQTT_PORT, 60)

    payload = json.dumps(data.message)
    client.publish(data.topic, payload)

    return {"status": "published", "topic": data.topic}
pass # publish 

# -----------------------------
# API - 전체 데이터 조회
# -----------------------------
@app.get("/fast/mqtt")
def get_all():
    return mqtt_data_store
pass # get_all

# -----------------------------
# API - 최신 데이터 조회
# -----------------------------
@app.get("/fast/mqtt/{topic:path}")
def get_topic(topic: str):
    if topic in mqtt_data_store:
        return {
            topic : mqtt_data_store[topic]
        }
    pass 

    return { "error": "No data" }
pass # get_topic

@app.get("/fast/hello")
def hello():
    return "hello world"
pass # hello

from ai_road_detect import router as ai_road_router
app.include_router(ai_road_router)

