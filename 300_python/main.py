import json
from fastapi import FastAPI
from pydantic import BaseModel
import paho.mqtt.client as mqtt
import threading

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
def on_connect(client, userdata, flags, rc):
    print("MQTT Connected:", rc)
    client.subscribe(MQTT_TOPIC)

def on_message(client, userdata, msg):
    payload = msg.payload.decode()
    print(f"Received: {msg.topic} -> {payload}")

    try:
        mqtt_data_store[msg.topic] = json.loads(payload)
    except:
        mqtt_data_store[msg.topic] = payload


# -----------------------------
# MQTT 클라이언트 시작
# -----------------------------
def start_mqtt():
    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message

    client.connect(MQTT_BROKER, MQTT_PORT, 60)
    client.loop_forever()


# 백그라운드 스레드 실행
threading.Thread(target=start_mqtt, daemon=True).start() 

# -----------------------------
# API 모델
# -----------------------------
class PublishModel(BaseModel):
    topic: str
    message: dict


# -----------------------------
# API - publish
# -----------------------------
@app.post("/mqtt/publish")
def publish(data: PublishModel):
    client = mqtt.Client()
    client.connect(MQTT_BROKER, MQTT_PORT, 60)

    payload = json.dumps(data.message)
    client.publish(data.topic, payload)

    return {"status": "published", "topic": data.topic}


# -----------------------------
# API - 최신 데이터 조회
# -----------------------------
@app.get("/mqtt/{topic:path}")
def get_latest(topic: str):
    if topic in mqtt_data_store:
        return {
            topic : mqtt_data_store[topic]
        }
    return {"error": "No data"}
pass 

# -----------------------------
# API - 전체 데이터 조회
# -----------------------------
@app.get("/mqtt")
def get_all():
    return mqtt_data_store