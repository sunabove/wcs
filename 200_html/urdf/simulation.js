
import * as THREE from 'three';

const RAPIER_CDN =
    'https://cdn.skypack.dev/@dimforge/rapier3d-compat@0.11.2';

const SIM_SPEED_DEFAULT_KMH = 10;
const SIM_SPEED_MAX_KMH = 20;

const DEG2RAD = Math.PI / 180;

const FIXED_TIME_STEP = 1 / 60;
const MAX_SUB_STEPS = 4;

const DEFAULT_VEHICLE_MASS = 120.0;
const DEFAULT_GRAVITY = 9.81;

const DEFAULT_WHEEL_RADIUS = 0.16;

const DEFAULT_ENGINE_FORCE = 1800.0;
const DEFAULT_BRAKE_FORCE = 3500.0;
const DEFAULT_ROLLING_RESISTANCE = 25.0;

const DEFAULT_MAX_STEER_DEG = 35.0;
const DEFAULT_MAX_STEER_RATE = 120.0;

const DEFAULT_MAX_SPEED =
    SIM_SPEED_MAX_KMH / 3.6;

function clamp(value, min, max)
{
    return Math.max(min, Math.min(max, value));
}

function moveTowards(current, target, delta)
{
    if (current < target)
    {
        return Math.min(current + delta, target);
    }

    if (current > target)
    {
        return Math.max(current - delta, target);
    }

    return current;
}

function sign(value)
{
    if (value > 0)
    {
        return 1;
    }

    if (value < 0)
    {
        return -1;
    }

    return 0;
}

class VehicleInput
{
    constructor()
    {
        this.throttle = 0.0;
        this.brake = 0.0;
        this.steer = 0.0;
    }

    reset()
    {
        this.throttle = 0.0;
        this.brake = 0.0;
        this.steer = 0.0;
    }
}

function setSliderVisualPercent(inputElement)
{
    if (!inputElement) {
        return;
    }

    const minValue = Number.parseFloat(inputElement.min);
    const maxValue = Number.parseFloat(inputElement.max);
    const currentValue = Number.parseFloat(inputElement.value);
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || maxValue <= minValue || !Number.isFinite(currentValue)) {
        inputElement.style.setProperty('--slider-percent', '0%');
        return;
    }

    const clampedValue = Math.max(minValue, Math.min(maxValue, currentValue));
    const percent = ((clampedValue - minValue) / (maxValue - minValue)) * 100;
    inputElement.style.setProperty('--slider-percent', `${percent}%`);
}

globalThis.resetSimulation = function () {
    if (typeof globalThis.setDriveMode === 'function') {
        globalThis.setDriveMode('stop');
    }

    if (typeof globalThis.setRoadRollAngleDeg === 'function') {
        globalThis.setRoadRollAngleDeg(0);
    }

    if (typeof globalThis.setRoadPitchAngleDeg === 'function') {
        globalThis.setRoadPitchAngleDeg(0);
    }
};

globalThis.resetSimulationSpeed = function () {
    const speedInput = document.getElementById('drive-speed-kmh');
    if (speedInput) {
        speedInput.value = String(SIM_SPEED_DEFAULT_KMH);
        setSliderVisualPercent(speedInput);
    }

    const speedLabel = document.getElementById('drive-speed-kmh-value');
    if (speedLabel) {
        speedLabel.textContent = `${SIM_SPEED_DEFAULT_KMH} km/h`;
    }

    if (typeof globalThis.setDriveSpeedKmh === 'function') {
        globalThis.setDriveSpeedKmh(SIM_SPEED_DEFAULT_KMH);
    }
};

globalThis.resetSimulationRoll = function () {
    if (typeof globalThis.setRoadRollAngleDeg === 'function') {
        globalThis.setRoadRollAngleDeg(0);
    }
};

globalThis.resetSimulationPitch = function () {
    if (typeof globalThis.setRoadPitchAngleDeg === 'function') {
        globalThis.setRoadPitchAngleDeg(0);
    }
};

globalThis.resetSimulationAttitude = function () {
    globalThis.resetSimulationRoll();
    globalThis.resetSimulationPitch();
};

class VehicleState
{
    constructor()
    {
        this.speed = 0.0;

        this.engineForce = 0.0;

        this.brakeForce = 0.0;

        this.rollingForce = 0.0;

        this.steerAngle = 0.0;

        this.leftForce = 0.0;

        this.rightForce = 0.0;

        this.velocity =
            new THREE.Vector3();

        this.acceleration =
            new THREE.Vector3();
    }

    clearForces()
    {
        this.engineForce = 0.0;

        this.brakeForce = 0.0;

        this.rollingForce = 0.0;

        this.leftForce = 0.0;

        this.rightForce = 0.0;
    }
}

class VehiclePhysicsBase
{
    constructor()
    {
        this.mass =
            DEFAULT_VEHICLE_MASS;

        this.gravity =
            DEFAULT_GRAVITY;

        this.wheelRadius =
            DEFAULT_WHEEL_RADIUS;

        this.maxSpeed =
            DEFAULT_MAX_SPEED;

        this.maxEngineForce =
            DEFAULT_ENGINE_FORCE;

        this.maxBrakeForce =
            DEFAULT_BRAKE_FORCE;

        this.rollingResistance =
            DEFAULT_ROLLING_RESISTANCE;

        this.maxSteerAngle =
            DEFAULT_MAX_STEER_DEG * DEG2RAD;

        this.maxSteerRate =
            DEFAULT_MAX_STEER_RATE * DEG2RAD;

        this.input =
            new VehicleInput();

        this.state =
            new VehicleState();
    }

    reset()
    {
        this.input.reset();

        this.state =
            new VehicleState();
    }
}



class VehiclePhysics
{
    constructor()
    {
        this.mass = DEFAULT_VEHICLE_MASS;
        this.gravity = DEFAULT_GRAVITY;

        this.wheelRadius = DEFAULT_WHEEL_RADIUS;

        this.maxSpeed = DEFAULT_MAX_SPEED;

        this.maxEngineForce = DEFAULT_ENGINE_FORCE;
        this.maxBrakeForce = DEFAULT_BRAKE_FORCE;

        this.rollingResistance = DEFAULT_ROLLING_RESISTANCE;

        this.maxSteerAngle =
            DEFAULT_MAX_STEER_DEG * DEG2RAD;

        this.maxSteerRate =
            DEFAULT_MAX_STEER_RATE * DEG2RAD;

        this.input = new VehicleInput();

        this.state = new VehicleState();
    }

    reset()
    {
        this.input.reset();
        this.state = new VehicleState();
    }

    //--------------------------------------------------
    // Input
    //--------------------------------------------------

    setThrottle(value)
    {
        this.input.throttle =
            clamp(value, -1.0, 1.0);
    }

    setBrake(value)
    {
        this.input.brake =
            clamp(value, 0.0, 1.0);
    }

    setSteering(value)
    {
        this.input.steer =
            clamp(value, -1.0, 1.0);
    }

    //--------------------------------------------------
    // Speed
    //--------------------------------------------------

    updateSpeed(body)
    {
        const vel = body.linvel();

        this.state.velocity.set(
            vel.x,
            vel.y,
            vel.z
        );

        this.state.speed =
            this.state.velocity.length();
    }

    //--------------------------------------------------
    // Engine
    //--------------------------------------------------

    updateEngineForce()
    {
        const throttle =
            this.input.throttle;

        const ratio =
            1.0 -
            clamp(
                this.state.speed /
                this.maxSpeed,
                0.0,
                1.0
            );

        this.state.engineForce =
            throttle *
            this.maxEngineForce *
            ratio;
    }

    //--------------------------------------------------
    // Brake
    //--------------------------------------------------

    updateBrakeForce()
    {
        this.state.brakeForce =
            this.input.brake *
            this.maxBrakeForce;
    }

    //--------------------------------------------------
    // Rolling Resistance
    //--------------------------------------------------

    updateRollingResistance()
    {
        if (this.state.speed < 0.02)
        {
            this.state.rollingForce = 0;
            return;
        }

        this.state.rollingForce =
            this.rollingResistance *
            sign(this.state.speed);
    }

    //--------------------------------------------------
    // Steering
    //--------------------------------------------------

    updateSteering(dt)
    {
        const targetAngle =
            this.input.steer *
            this.maxSteerAngle;

        this.state.steerAngle =
            moveTowards(
                this.state.steerAngle,
                targetAngle,
                this.maxSteerRate * dt
            );
    }

    //--------------------------------------------------
    // Differential
    //--------------------------------------------------

    updateDifferential()
    {
        const steerRatio =
            Math.abs(
                this.state.steerAngle /
                this.maxSteerAngle
            );

        const inside =
            1.0 - steerRatio * 0.15;

        const outside =
            1.0 + steerRatio * 0.15;

        if (this.state.steerAngle > 0)
        {
            this.state.leftForce =
                this.state.engineForce *
                inside;

            this.state.rightForce =
                this.state.engineForce *
                outside;
        }
        else
        {
            this.state.leftForce =
                this.state.engineForce *
                outside;

            this.state.rightForce =
                this.state.engineForce *
                inside;
        }
    }

    //--------------------------------------------------
    // Total Force
    //--------------------------------------------------

    computeDriveForce()
    {
        return (
            this.state.engineForce
            - this.state.brakeForce
            - this.state.rollingForce
        );
    }

    //--------------------------------------------------
    // Main Update
    //--------------------------------------------------

    update(body, dt)
    {
        this.state.clearForces();

        this.updateSpeed(body);

        this.updateEngineForce();

        this.updateBrakeForce();

        this.updateRollingResistance();

        this.updateSteering(dt);

        this.updateDifferential();
    }
}



// RapierDriveSimulation

export class RapierDriveSimulation
{
    constructor(viewer)
    {
        this.viewer = viewer;

        this.world = null;

        this.vehicleBody = null;

        this.vehicleCollider = null;

        this.vehiclePhysics =
            new VehiclePhysics();

        this.clock =
            new THREE.Clock();

        this.accumulator = 0.0;

        this.fixedStep =
            FIXED_TIME_STEP;

        this.keys =
        {
            forward : false,
            backward : false,
            left : false,
            right : false,
            brake : false
        };

        this.tmpForward =
            new THREE.Vector3();

        this.tmpRight =
            new THREE.Vector3();

        this.tmpUp =
            new THREE.Vector3();

        this.tmpQuat =
            new THREE.Quaternion();

        this.tmpEuler =
            new THREE.Euler();

        this.tmpForce =
            new THREE.Vector3();

        this.tmpTorque =
            new THREE.Vector3();
    }

    //--------------------------------------------------
    // Rapier
    //--------------------------------------------------

    async initialize()
    {
        const module =
            await import(RAPIER_CDN);

        await module.init();

        this.RAPIER = module;

        this.world =
            new module.World(
                {
                    x : 0,
                    y : -9.81,
                    z : 0
                });

        this.createGround();
    }

    createGround()
    {
        if (!this.world || !this.RAPIER) {
            return;
        }

        const groundBodyDesc = this.RAPIER.RigidBodyDesc.fixed();
        const groundBody = this.world.createRigidBody(groundBodyDesc);
        const groundColliderDesc = this.RAPIER.ColliderDesc.cuboid(200, 0.1, 200);
        this.world.createCollider(groundColliderDesc, groundBody);
    }

    updateDiagnostics()
    {
        // Placeholder: keep frame update stable even when diagnostics UI is absent.
    }

    //--------------------------------------------------
    // Vehicle
    //--------------------------------------------------

    attachVehicle(body)
    {
        this.vehicleBody = body;
    }

    //--------------------------------------------------
    // Keyboard
    //--------------------------------------------------

    keyDown(code)
    {
        switch(code)
        {
        case "KeyW":
        case "ArrowUp":
            this.keys.forward = true;
            break;

        case "KeyS":
        case "ArrowDown":
            this.keys.backward = true;
            break;

        case "KeyA":
        case "ArrowLeft":
            this.keys.left = true;
            break;

        case "KeyD":
        case "ArrowRight":
            this.keys.right = true;
            break;

        case "Space":
            this.keys.brake = true;
            break;
        }
    }

    keyUp(code)
    {
        switch(code)
        {
        case "KeyW":
        case "ArrowUp":
            this.keys.forward = false;
            break;

        case "KeyS":
        case "ArrowDown":
            this.keys.backward = false;
            break;

        case "KeyA":
        case "ArrowLeft":
            this.keys.left = false;
            break;

        case "KeyD":
        case "ArrowRight":
            this.keys.right = false;
            break;

        case "Space":
            this.keys.brake = false;
            break;
        }
    }

    //--------------------------------------------------
    // Driver Input
    //--------------------------------------------------

    updateInput()
    {
        let throttle = 0.0;

        if (this.keys.forward)
        {
            throttle += 1.0;
        }

        if (this.keys.backward)
        {
            throttle -= 1.0;
        }

        let steer = 0.0;

        if (this.keys.left)
        {
            steer += 1.0;
        }

        if (this.keys.right)
        {
            steer -= 1.0;
        }

        const brake =
            this.keys.brake ? 1.0 : 0.0;

        this.vehiclePhysics.setThrottle(
            throttle);

        this.vehiclePhysics.setBrake(
            brake);

        this.vehiclePhysics.setSteering(
            steer);
    }



// Force / Torque Application

    //--------------------------------------------------
    // Vehicle Axis
    //--------------------------------------------------

    updateVehicleAxes()
    {
        if (!this.vehicleBody)
        {
            return;
        }

        const rot =
            this.vehicleBody.rotation();

        this.tmpQuat.set(
            rot.x,
            rot.y,
            rot.z,
            rot.w
        );

        this.tmpForward
            .set(0, 0, 1)
            .applyQuaternion(this.tmpQuat)
            .normalize();

        this.tmpRight
            .set(1, 0, 0)
            .applyQuaternion(this.tmpQuat)
            .normalize();

        this.tmpUp
            .set(0, 1, 0)
            .applyQuaternion(this.tmpQuat)
            .normalize();
    }

    //--------------------------------------------------
    // Engine Force
    //--------------------------------------------------

    applyEngineForce()
    {
        const force =
            this.vehiclePhysics.state.engineForce;

        if (Math.abs(force) < 0.001)
        {
            return;
        }

        this.tmpForce
            .copy(this.tmpForward)
            .multiplyScalar(force);

        this.vehicleBody.addForce(
            {
                x : this.tmpForce.x,
                y : this.tmpForce.y,
                z : this.tmpForce.z
            },
            true
        );
    }

    //--------------------------------------------------
    // Brake Force
    //--------------------------------------------------

    applyBrakeForce()
    {
        const brake =
            this.vehiclePhysics.state.brakeForce;

        if (brake <= 0.0)
        {
            return;
        }

        const vel =
            this.vehiclePhysics.state.velocity;

        if (vel.lengthSq() < 0.00001)
        {
            return;
        }

        this.tmpForce
            .copy(vel)
            .normalize()
            .multiplyScalar(-brake);

        this.vehicleBody.addForce(
            {
                x : this.tmpForce.x,
                y : this.tmpForce.y,
                z : this.tmpForce.z
            },
            true
        );
    }

    //--------------------------------------------------
    // Rolling Resistance
    //--------------------------------------------------

    applyRollingResistance()
    {
        const rr =
            this.vehiclePhysics.state.rollingForce;

        if (rr <= 0.0)
        {
            return;
        }

        const vel =
            this.vehiclePhysics.state.velocity;

        if (vel.lengthSq() < 0.00001)
        {
            return;
        }

        this.tmpForce
            .copy(vel)
            .normalize()
            .multiplyScalar(-rr);

        this.vehicleBody.addForce(
            {
                x : this.tmpForce.x,
                y : this.tmpForce.y,
                z : this.tmpForce.z
            },
            true
        );
    }

    //--------------------------------------------------
    // Steering Torque
    //--------------------------------------------------

    applySteeringTorque()
    {
        const angle =
            this.vehiclePhysics.state.steerAngle;

        if (Math.abs(angle) < 0.0001)
        {
            return;
        }

        const speed =
            this.vehiclePhysics.state.speed;

        if (speed < 0.1)
        {
            return;
        }

        const gain =
            THREE.MathUtils.clamp(
                speed / 2.0,
                0.2,
                1.0
            );

        const yawTorque =
            angle * 800.0 * gain;

        this.tmpTorque.set(
            0,
            yawTorque,
            0
        );

        this.vehicleBody.addTorque(
            {
                x : this.tmpTorque.x,
                y : this.tmpTorque.y,
                z : this.tmpTorque.z
            },
            true
        );
    }


// Fixed Step Simulation

    //--------------------------------------------------
    // Fixed Simulation
    //--------------------------------------------------

    stepSimulation(deltaTime)
    {
        if (!this.world)
        {
            return;
        }

        if (!this.vehicleBody)
        {
            this.world.step();
            return;
        }

        //--------------------------------------------------
        // Clamp Frame Time
        //--------------------------------------------------

        deltaTime =
            Math.min(deltaTime, 0.05);

        this.accumulator += deltaTime;

        //--------------------------------------------------
        // Fixed Time Step
        //--------------------------------------------------

        let stepCount = 0;

        while (
            this.accumulator >= this.fixedStep &&
            stepCount < MAX_SUB_STEPS)
        {
            this.simulationStep(
                this.fixedStep);

            this.accumulator -=
                this.fixedStep;

            stepCount++;
        }
    }

    //--------------------------------------------------
    // One Physics Step
    //--------------------------------------------------

    simulationStep(dt)
    {
        this.updateVehiclePhysics(dt);

        //--------------------------------------------------
        // Physics
        //--------------------------------------------------

        this.world.step();

        //--------------------------------------------------
        // Sync Mesh
        //--------------------------------------------------

        this.updateVehicleMesh();

        //--------------------------------------------------
        // HUD
        //--------------------------------------------------

        this.updateDiagnostics();
    }

    //--------------------------------------------------
    // Vehicle Mesh
    //--------------------------------------------------

    updateVehicleMesh()
    {
        if (!this.viewer)
        {
            return;
        }

        if (!this.viewer.robot)
        {
            return;
        }

        const body =
            this.vehicleBody;

        const pos =
            body.translation();

        const rot =
            body.rotation();

        this.viewer.robot.position.set(
            pos.x,
            pos.y,
            pos.z
        );

        this.viewer.robot.quaternion.set(
            rot.x,
            rot.y,
            rot.z,
            rot.w
        );
    }

    //--------------------------------------------------
    // Reset
    //--------------------------------------------------

    resetVehicle()
    {
        if (!this.vehicleBody)
        {
            return;
        }

        this.vehicleBody.setTranslation(
            {
                x : 0,
                y : 0.5,
                z : 0
            },
            true
        );

        this.vehicleBody.setRotation(
            {
                x : 0,
                y : 0,
                z : 0,
                w : 1
            },
            true
        );

        this.vehicleBody.setLinvel(
            {
                x : 0,
                y : 0,
                z : 0
            },
            true
        );

        this.vehicleBody.setAngvel(
            {
                x : 0,
                y : 0,
                z : 0
            },
            true
        );

        this.vehiclePhysics.reset();
    }


// Wheel Contact (RayCast)

    //--------------------------------------------------
    // Wheel Contact
    //--------------------------------------------------

    createWheelContactSystem()
    {
        this.wheels =
        [
            {
                name : "frontLeft",
                local :
                    new THREE.Vector3(-0.35, -0.15, 0.55),
                contact : false,
                distance : 0,
                hitPoint : new THREE.Vector3(),
                hitNormal : new THREE.Vector3()
            },

            {
                name : "frontRight",
                local :
                    new THREE.Vector3(0.35, -0.15, 0.55),
                contact : false,
                distance : 0,
                hitPoint : new THREE.Vector3(),
                hitNormal : new THREE.Vector3()
            },

            {
                name : "rearLeft",
                local :
                    new THREE.Vector3(-0.35, -0.15, -0.55),
                contact : false,
                distance : 0,
                hitPoint : new THREE.Vector3(),
                hitNormal : new THREE.Vector3()
            },

            {
                name : "rearRight",
                local :
                    new THREE.Vector3(0.35, -0.15, -0.55),
                contact : false,
                distance : 0,
                hitPoint : new THREE.Vector3(),
                hitNormal : new THREE.Vector3()
            }
        ];

        this.contactCount = 0;
    }

    //--------------------------------------------------
    // World Position
    //--------------------------------------------------

    getWheelWorldPosition(wheel)
    {
        const bodyPos =
            this.vehicleBody.translation();

        wheel.world =
            wheel.local.clone()
                .applyQuaternion(this.tmpQuat)
                .add(
                    new THREE.Vector3(
                        bodyPos.x,
                        bodyPos.y,
                        bodyPos.z
                    )
                );
    }

    //--------------------------------------------------
    // Ray Cast
    //--------------------------------------------------

    raycastWheel(wheel)
    {
        this.getWheelWorldPosition(wheel);

        const origin =
        {
            x : wheel.world.x,
            y : wheel.world.y,
            z : wheel.world.z
        };

        const direction =
        {
            x : 0,
            y : -1,
            z : 0
        };

        const ray =
            new this.RAPIER.Ray(
                origin,
                direction
            );

        const maxDistance =
            this.vehiclePhysics.wheelRadius + 0.25;

        const hit =
            this.world.castRay(
                ray,
                maxDistance,
                true
            );

        if (!hit)
        {
            wheel.contact = false;
            wheel.distance = maxDistance;
            return;
        }

        wheel.contact = true;

        wheel.distance =
            hit.timeOfImpact;

        wheel.hitPoint.set(
            origin.x,
            origin.y - hit.timeOfImpact,
            origin.z
        );
    }

    //--------------------------------------------------
    // Update Contact
    //--------------------------------------------------

    updateWheelContacts()
    {
        this.contactCount = 0;

        for (const wheel of this.wheels)
        {
            this.raycastWheel(wheel);

            if (wheel.contact)
            {
                this.contactCount++;
            }
        }
    }

    //--------------------------------------------------
    // Ground Ratio
    //--------------------------------------------------

    getGroundContactRatio()
    {
        return this.contactCount / 4.0;
    }

    //--------------------------------------------------
    // Grounded?
    //--------------------------------------------------

    isGrounded()
    {
        return this.contactCount > 0;
    }

    //--------------------------------------------------
    // Engine Correction
    //--------------------------------------------------

    applyGroundCorrection()
    {
        const ratio =
            this.getGroundContactRatio();

        this.vehiclePhysics.state.engineForce *=
            ratio;

        if (ratio < 0.25)
        {
            this.vehiclePhysics.state.brakeForce *=
                0.2;
        }
    }



// Suspension (Spring + Damper)

    //--------------------------------------------------
    // Suspension Parameters
    //--------------------------------------------------

    createSuspension()
    {
        this.suspension =
        {
            springLength : 0.25,

            wheelRadius :
                this.vehiclePhysics.wheelRadius,

            springK : 32000.0,

            damperC : 4200.0,

            maxForce : 45000.0
        };

        for (const wheel of this.wheels)
        {
            wheel.lastCompression = 0.0;
            wheel.compression = 0.0;
            wheel.springForce = 0.0;
            wheel.damperForce = 0.0;
            wheel.totalForce = 0.0;
        }
    }

    //--------------------------------------------------
    // Spring Compression
    //--------------------------------------------------

    updateSuspensionCompression(wheel)
    {
        if (!wheel.contact)
        {
            wheel.lastCompression =
                wheel.compression;

            wheel.compression = 0.0;

            return;
        }

        const restLength =
            this.suspension.springLength;

        const travel =
            wheel.distance -
            this.suspension.wheelRadius;

        wheel.lastCompression =
            wheel.compression;

        wheel.compression =
            clamp(
                restLength - travel,
                0.0,
                restLength
            );
    }

    //--------------------------------------------------
    // Spring Force
    //--------------------------------------------------

    computeSpringForce(wheel)
    {
        wheel.springForce =
            wheel.compression *
            this.suspension.springK;
    }

    //--------------------------------------------------
    // Damper Force
    //--------------------------------------------------

    computeDamperForce(wheel, dt)
    {
        const velocity =
            (wheel.compression -
             wheel.lastCompression) / dt;

        wheel.damperForce =
            velocity *
            this.suspension.damperC;
    }

    //--------------------------------------------------
    // Total Suspension Force
    //--------------------------------------------------

    computeSuspensionForce(wheel)
    {
        wheel.totalForce =
            wheel.springForce -
            wheel.damperForce;

        wheel.totalForce =
            clamp(
                wheel.totalForce,
                0.0,
                this.suspension.maxForce
            );
    }

    //--------------------------------------------------
    // Apply Force
    //--------------------------------------------------

    applySuspensionForce(wheel)
    {
        if (!wheel.contact)
        {
            return;
        }

        this.tmpForce
            .copy(this.tmpUp)
            .multiplyScalar(
                wheel.totalForce
            );

        this.vehicleBody.addForceAtPoint(
        {
            x : this.tmpForce.x,
            y : this.tmpForce.y,
            z : this.tmpForce.z
        },
        {
            x : wheel.hitPoint.x,
            y : wheel.hitPoint.y,
            z : wheel.hitPoint.z
        },
        true);
    }


// Rapier Suspension
// Force + Torque (r x F)

    //--------------------------------------------------
    // Apply Suspension
    //--------------------------------------------------

    applySuspension()
    {
        for (const wheel of this.wheels)
        {
            this.updateSuspensionCompression(
                wheel);

            this.computeSpringForce(
                wheel);

            this.computeDamperForce(
                wheel,
                this.fixedStep);

            this.computeSuspensionForce(
                wheel);

            this.applyWheelForce(
                wheel);
        }
    }

    //--------------------------------------------------
    // Force At Wheel
    //--------------------------------------------------

    applyWheelForce(wheel)
    {
        if (!wheel.contact)
        {
            return;
        }

        //------------------------------------------
        // Force
        //------------------------------------------

        this.tmpForce
            .copy(this.tmpUp)
            .multiplyScalar(
                wheel.totalForce);

        //------------------------------------------
        // Body Center
        //------------------------------------------

        const bodyPos =
            this.vehicleBody.translation();

        const center =
            new THREE.Vector3(
                bodyPos.x,
                bodyPos.y,
                bodyPos.z);

        //------------------------------------------
        // r = Wheel - Center
        //------------------------------------------

        const r =
            wheel.hitPoint.clone()
                .sub(center);

        //------------------------------------------
        // ? = r 횞 F
        //------------------------------------------

        this.tmpTorque
            .copy(r)
            .cross(this.tmpForce);

        //------------------------------------------
        // Apply Force
        //------------------------------------------

        this.vehicleBody.addForce(
        {
            x : this.tmpForce.x,
            y : this.tmpForce.y,
            z : this.tmpForce.z
        },
        true);

        //------------------------------------------
        // Apply Torque
        //------------------------------------------

        this.vehicleBody.addTorque(
        {
            x : this.tmpTorque.x,
            y : this.tmpTorque.y,
            z : this.tmpTorque.z
        },
        true);
    }


// Tire Model
// Longitudinal / Lateral Slip

    //--------------------------------------------------
    // Tire Parameters
    //--------------------------------------------------

    createTireModel()
    {
        this.tire =
        {
            mu : 0.90,

            longitudinalStiffness : 9.0,

            lateralStiffness : 7.0,

            maxSlipRatio : 0.25,

            maxSlipAngle : 15.0 * DEG2RAD
        };

        for (const wheel of this.wheels)
        {
            wheel.forwardSpeed = 0.0;
            wheel.sideSpeed = 0.0;

            wheel.slipRatio = 0.0;
            wheel.slipAngle = 0.0;

            wheel.longitudinalForce = 0.0;
            wheel.lateralForce = 0.0;
        }
    }

    //--------------------------------------------------
    // Wheel Velocity
    //--------------------------------------------------

    updateWheelVelocity(wheel)
    {
        const vel =
            this.vehiclePhysics.state.velocity;

        wheel.forwardSpeed =
            vel.dot(this.tmpForward);

        wheel.sideSpeed =
            vel.dot(this.tmpRight);
    }

    //--------------------------------------------------
    // Longitudinal Slip
    //--------------------------------------------------

    computeSlipRatio(wheel)
    {
        const desiredSpeed =
            this.vehiclePhysics.input.throttle *
            this.vehiclePhysics.maxSpeed;

        const denom =
            Math.max(
                Math.abs(wheel.forwardSpeed),
                0.5);

        wheel.slipRatio =
            (desiredSpeed -
             wheel.forwardSpeed) / denom;

        wheel.slipRatio =
            clamp(
                wheel.slipRatio,
                -this.tire.maxSlipRatio,
                 this.tire.maxSlipRatio);
    }

    //--------------------------------------------------
    // Lateral Slip
    //--------------------------------------------------

    computeSlipAngle(wheel)
    {
        wheel.slipAngle =
            Math.atan2(
                wheel.sideSpeed,
                Math.abs(wheel.forwardSpeed) + 0.01);

        wheel.slipAngle =
            clamp(
                wheel.slipAngle,
                -this.tire.maxSlipAngle,
                 this.tire.maxSlipAngle);
    }

    //--------------------------------------------------
    // Longitudinal Tire Force
    //--------------------------------------------------

    computeLongitudinalForce(wheel)
    {
        wheel.longitudinalForce =
            wheel.slipRatio *
            this.tire.longitudinalStiffness *
            wheel.totalForce;

        const limit =
            wheel.totalForce *
            this.tire.mu;

        wheel.longitudinalForce =
            clamp(
                wheel.longitudinalForce,
                -limit,
                 limit);
    }

    //--------------------------------------------------
    // Lateral Tire Force
    //--------------------------------------------------

    computeLateralForce(wheel)
    {
        wheel.lateralForce =
            wheel.slipAngle *
            this.tire.lateralStiffness *
            wheel.totalForce;

        const limit =
            wheel.totalForce *
            this.tire.mu;

        wheel.lateralForce =
            clamp(
                wheel.lateralForce,
                -limit,
                 limit);
    }


// Tire Force Application

    //--------------------------------------------------
    // Friction Circle
    //--------------------------------------------------

    applyFrictionCircle(wheel)
    {
        const limit =
            wheel.totalForce *
            this.tire.mu;

        const fx =
            wheel.longitudinalForce;

        const fy =
            wheel.lateralForce;

        const magnitude =
            Math.sqrt(
                fx * fx +
                fy * fy);

        if (magnitude <= limit)
        {
            return;
        }

        const scale =
            limit / magnitude;

        wheel.longitudinalForce *= scale;
        wheel.lateralForce *= scale;
    }

    //--------------------------------------------------
    // Tire Force Vector
    //--------------------------------------------------

    buildTireForce(wheel)
    {
        this.tmpForce
            .set(0, 0, 0);

        //--------------------------------------
        // Longitudinal
        //--------------------------------------

        this.tmpForce.add(
            this.tmpForward
                .clone()
                .multiplyScalar(
                    wheel.longitudinalForce));

        //--------------------------------------
        // Lateral
        //--------------------------------------

        this.tmpForce.add(
            this.tmpRight
                .clone()
                .multiplyScalar(
                    -wheel.lateralForce));
    }

    //--------------------------------------------------
    // Tire Torque
    //--------------------------------------------------

    buildTireTorque(wheel)
    {
        const bodyPos =
            this.vehicleBody.translation();

        const center =
            new THREE.Vector3(
                bodyPos.x,
                bodyPos.y,
                bodyPos.z);

        const arm =
            wheel.hitPoint.clone()
                .sub(center);

        this.tmpTorque
            .copy(arm)
            .cross(this.tmpForce);
    }

    //--------------------------------------------------
    // Apply Tire Force
    //--------------------------------------------------

    applyTireForce(wheel)
    {
        if (!wheel.contact)
        {
            return;
        }

        this.applyFrictionCircle(
            wheel);

        this.buildTireForce(
            wheel);

        this.buildTireTorque(
            wheel);

        //--------------------------------------
        // Force
        //--------------------------------------

        this.vehicleBody.addForce(
        {
            x : this.tmpForce.x,
            y : this.tmpForce.y,
            z : this.tmpForce.z
        },
        true);

        //--------------------------------------
        // Torque
        //--------------------------------------

        this.vehicleBody.addTorque(
        {
            x : this.tmpTorque.x,
            y : this.tmpTorque.y,
            z : this.tmpTorque.z
        },
        true);
    }

    //--------------------------------------------------
    // Tire Update
    //--------------------------------------------------

    updateTires()
    {
        for (const wheel of this.wheels)
        {
            if (!wheel.contact)
            {
                continue;
            }

            this.updateWheelVelocity(
                wheel);

            this.computeSlipRatio(
                wheel);

            this.computeSlipAngle(
                wheel);

            this.computeLongitudinalForce(
                wheel);

            this.computeLateralForce(
                wheel);

            this.applyTireForce(
                wheel);
        }
    }



// Drive Train
// Wheel Rotation / Drive Mode / Differential

    //--------------------------------------------------
    // Drive Train
    //--------------------------------------------------

    createDriveTrain()
    {
        this.driveTrain =
        {
            mode : "4WD",

            differential : "OPEN",

            wheelBase : 1.10,

            trackWidth : 0.70,

            wheelInertia : 0.18,

            maxWheelSpeed : 120.0
        };

        for (const wheel of this.wheels)
        {
            wheel.drive = true;

            wheel.angularVelocity = 0.0;

            wheel.rotation = 0.0;

            wheel.driveTorque = 0.0;

            wheel.brakeTorque = 0.0;
        }

        this.setDriveMode(
            this.driveTrain.mode);
    }

    //--------------------------------------------------
    // Drive Mode
    //--------------------------------------------------

    setDriveMode(mode)
    {
        this.driveTrain.mode = mode;

        for (const wheel of this.wheels)
        {
            wheel.drive = false;
        }

        switch(mode)
        {
        case "FWD":

            this.wheels[0].drive = true;
            this.wheels[1].drive = true;
            break;

        case "RWD":

            this.wheels[2].drive = true;
            this.wheels[3].drive = true;
            break;

        default:

            for (const wheel of this.wheels)
            {
                wheel.drive = true;
            }

            break;
        }
    }

    //--------------------------------------------------
    // Differential
    //--------------------------------------------------

    updateDifferential()
    {
        const totalTorque =
            this.vehiclePhysics.state.engineForce *
            this.vehiclePhysics.wheelRadius;

        const driveWheels =
            this.wheels.filter(
                w => w.drive);

        if (driveWheels.length === 0)
        {
            return;
        }

        switch(this.driveTrain.differential)
        {
        //------------------------------------------
        // OPEN
        //------------------------------------------

        case "OPEN":

            for (const wheel of driveWheels)
            {
                wheel.driveTorque =
                    totalTorque /
                    driveWheels.length;
            }

            break;

        //------------------------------------------
        // LOCKED
        //------------------------------------------

        case "LOCKED":

            const avg =
                driveWheels.reduce(
                    (s, w) =>
                        s + w.angularVelocity,
                    0) /
                driveWheels.length;

            for (const wheel of driveWheels)
            {
                wheel.angularVelocity = avg;

                wheel.driveTorque =
                    totalTorque /
                    driveWheels.length;
            }

            break;

        //------------------------------------------
        // LSD
        //------------------------------------------

        case "LSD":

            const maxSlip = 8.0;

            for (const wheel of driveWheels)
            {
                const slip =
                    Math.abs(
                        wheel.angularVelocity -
                        this.vehiclePhysics.state.speed);

                const gain =
                    clamp(
                        1.0 -
                        slip /
                        maxSlip,
                        0.3,
                        1.0);

                wheel.driveTorque =
                    gain *
                    totalTorque /
                    driveWheels.length;
            }

            break;
        }
    }

    //--------------------------------------------------
    // Wheel Rotation
    //--------------------------------------------------

    updateWheelRotation(dt)
    {
        for (const wheel of this.wheels)
        {
            const alpha =
                wheel.driveTorque /
                this.driveTrain.wheelInertia;

            wheel.angularVelocity +=
                alpha * dt;

            wheel.angularVelocity =
                clamp(
                    wheel.angularVelocity,
                    -this.driveTrain.maxWheelSpeed,
                     this.driveTrain.maxWheelSpeed);

            wheel.rotation +=
                wheel.angularVelocity * dt;
        }
    }


// ABS / TCS / Stability Assist

    //--------------------------------------------------
    // Driver Assist
    //--------------------------------------------------

    createDriverAssist()
    {
        this.driverAssist =
        {
            absEnabled : true,

            tcsEnabled : true,

            espEnabled : true,

            absSlip : 0.18,

            tcsSlip : 0.12,

            yawGain : 1800.0
        };
    }

    //--------------------------------------------------
    // Wheel Slip
    //--------------------------------------------------

    updateWheelSlip(wheel)
    {
        const vehicleSpeed =
            Math.max(
                this.vehiclePhysics.state.speed,
                0.1);

        const wheelSpeed =
            Math.abs(
                wheel.angularVelocity *
                this.vehiclePhysics.wheelRadius);

        wheel.slip =
            (wheelSpeed -
             vehicleSpeed) /
            vehicleSpeed;
    }

    //--------------------------------------------------
    // Traction Control
    //--------------------------------------------------

    applyTractionControl(wheel)
    {
        if (!this.driverAssist.tcsEnabled)
        {
            return;
        }

        if (!wheel.drive)
        {
            return;
        }

        if (wheel.slip <
            this.driverAssist.tcsSlip)
        {
            return;
        }

        const excess =
            wheel.slip -
            this.driverAssist.tcsSlip;

        const gain =
            clamp(
                1.0 -
                excess * 2.0,
                0.25,
                1.0);

        wheel.driveTorque *= gain;
    }

    //--------------------------------------------------
    // Anti-lock Brake
    //--------------------------------------------------

    applyABS(wheel)
    {
        if (!this.driverAssist.absEnabled)
        {
            return;
        }

        if (this.vehiclePhysics.input.brake <= 0)
        {
            return;
        }

        if (wheel.slip >
            this.driverAssist.absSlip)
        {
            return;
        }

        const deficit =
            this.driverAssist.absSlip -
            wheel.slip;

        const gain =
            clamp(
                1.0 -
                deficit * 3.0,
                0.2,
                1.0);

        wheel.brakeTorque *= gain;
    }

    //--------------------------------------------------
    // Electronic Stability Assist
    //--------------------------------------------------

    applyESP()
    {
        if (!this.driverAssist.espEnabled)
        {
            return;
        }

        const ang =
            this.vehicleBody.angvel();

        const desiredYaw =
            this.vehiclePhysics.state.steerAngle *
            this.vehiclePhysics.state.speed;

        const yawError =
            desiredYaw - ang.y;

        this.vehicleBody.addTorque(
        {
            x : 0,
            y : yawError *
                this.driverAssist.yawGain,
            z : 0
        },
        true);
    }

    //--------------------------------------------------
    // Driver Assist Update
    //--------------------------------------------------

    updateDriverAssist()
    {
        for (const wheel of this.wheels)
        {
            this.updateWheelSlip(
                wheel);

            this.applyTractionControl(
                wheel);

            this.applyABS(
                wheel);
        }

        this.applyESP();
    }



// Surface Material System

    //--------------------------------------------------
    // Surface Materials
    //--------------------------------------------------

    createSurfaceDatabase()
    {
        this.surfaceTable =
        {
            asphalt :
            {
                friction : 0.95,
                rollingResistance : 22.0,
                damping : 1.0
            },

            concrete :
            {
                friction : 0.90,
                rollingResistance : 24.0,
                damping : 1.0
            },

            gravel :
            {
                friction : 0.72,
                rollingResistance : 40.0,
                damping : 1.15
            },

            dirt :
            {
                friction : 0.63,
                rollingResistance : 55.0,
                damping : 1.20
            },

            grass :
            {
                friction : 0.55,
                rollingResistance : 70.0,
                damping : 1.30
            },

            mud :
            {
                friction : 0.40,
                rollingResistance : 120.0,
                damping : 1.55
            },

            sand :
            {
                friction : 0.36,
                rollingResistance : 180.0,
                damping : 1.80
            },

            wet :
            {
                friction : 0.45,
                rollingResistance : 40.0,
                damping : 1.10
            },

            ice :
            {
                friction : 0.08,
                rollingResistance : 8.0,
                damping : 0.90
            }
        };

        this.defaultSurface =
            "asphalt";
    }

    //--------------------------------------------------
    // Material Name
    //--------------------------------------------------

    getSurfaceName(collider)
    {
        if (!collider)
        {
            return this.defaultSurface;
        }

        const obj =
            collider.userData;

        if (!obj)
        {
            return this.defaultSurface;
        }

        if (!obj.surface)
        {
            return this.defaultSurface;
        }

        return obj.surface;
    }

    //--------------------------------------------------
    // Surface Data
    //--------------------------------------------------

    getSurfaceData(name)
    {
        if (this.surfaceTable[name])
        {
            return this.surfaceTable[name];
        }

        return this.surfaceTable[
            this.defaultSurface];
    }

    //--------------------------------------------------
    // Wheel Surface
    //--------------------------------------------------

    updateWheelSurface(wheel)
    {
        const collider =
            wheel.hitCollider;

        const surface =
            this.getSurfaceName(
                collider);

        wheel.surface = surface;

        wheel.surfaceData =
            this.getSurfaceData(
                surface);
    }

    //--------------------------------------------------
    // Tire Parameter
    //--------------------------------------------------

    updateWheelFriction(wheel)
    {
        if (!wheel.surfaceData)
        {
            return;
        }

        this.tire.mu =
            wheel.surfaceData.friction;
    }

    //--------------------------------------------------
    // Rolling Resistance
    //--------------------------------------------------

    updateWheelRollingResistance(
        wheel)
    {
        if (!wheel.surfaceData)
        {
            return;
        }

        wheel.rollingResistance =
            wheel.surfaceData
                .rollingResistance;
    }



// Per Wheel Surface Model

    //--------------------------------------------------
    // Wheel Surface State
    //--------------------------------------------------

    initializeWheelSurface(wheel)
    {
        wheel.surfaceName =
            this.defaultSurface;

        wheel.friction =
            this.surfaceTable[
                this.defaultSurface
            ].friction;

        wheel.rollingResistance =
            this.surfaceTable[
                this.defaultSurface
            ].rollingResistance;

        wheel.surfaceDamping =
            this.surfaceTable[
                this.defaultSurface
            ].damping;
    }

    //--------------------------------------------------
    // Surface Update
    //--------------------------------------------------

    updateWheelSurfaceState(wheel)
    {
        if (!wheel.contact)
        {
            this.initializeWheelSurface(
                wheel);

            return;
        }

        this.updateWheelSurface(
            wheel);

        const data =
            wheel.surfaceData;

        wheel.friction =
            data.friction;

        wheel.rollingResistance =
            data.rollingResistance;

        wheel.surfaceDamping =
            data.damping;
    }

    //--------------------------------------------------
    // Tire Force
    //--------------------------------------------------

    computeWheelLongitudinalForce(
        wheel)
    {
        wheel.longitudinalForce =
            wheel.slipRatio *
            this.tire.longitudinalStiffness *
            wheel.totalForce;

        const limit =
            wheel.totalForce *
            wheel.friction;

        wheel.longitudinalForce =
            clamp(
                wheel.longitudinalForce,
                -limit,
                 limit);
    }

    //--------------------------------------------------
    // Lateral Force
    //--------------------------------------------------

    computeWheelLateralForce(
        wheel)
    {
        wheel.lateralForce =
            wheel.slipAngle *
            this.tire.lateralStiffness *
            wheel.totalForce;

        const limit =
            wheel.totalForce *
            wheel.friction;

        wheel.lateralForce =
            clamp(
                wheel.lateralForce,
                -limit,
                 limit);
    }

    //--------------------------------------------------
    // Wheel Rolling Resistance
    //--------------------------------------------------

    applyWheelRollingResistance(
        wheel)
    {
        if (!wheel.contact)
        {
            return;
        }

        const vel =
            this.vehiclePhysics.state.velocity;

        if (vel.lengthSq() < 0.001)
        {
            return;
        }

        const force =
            wheel.rollingResistance;

        this.tmpForce
            .copy(vel)
            .normalize()
            .multiplyScalar(
                -force);

        this.vehicleBody.addForce(
        {
            x : this.tmpForce.x,
            y : this.tmpForce.y,
            z : this.tmpForce.z
        },
        true);
    }

    //--------------------------------------------------
    // Surface Update
    //--------------------------------------------------

    updateSurfacePhysics()
    {
        for (const wheel of this.wheels)
        {
            this.updateWheelSurfaceState(
                wheel);

            this.applyWheelRollingResistance(
                wheel);
        }
    }

    //--------------------------------------------------
    // Vehicle Update
    //--------------------------------------------------

    updateVehiclePhysics(dt)
    {
        this.updateInput();

        this.vehiclePhysics.update(
            this.vehicleBody,
            dt);

        this.updateVehicleAxes();

        //------------------------------------
        // Contact
        //------------------------------------

        this.updateWheelContacts();

        //------------------------------------
        // Surface
        //------------------------------------

        this.updateSurfacePhysics();

        //------------------------------------
        // Ground
        //------------------------------------

        this.applyGroundCorrection();

        //------------------------------------
        // Suspension
        //------------------------------------

        this.applySuspension();

        //------------------------------------
        // Differential
        //------------------------------------

        this.updateDifferential();

        //------------------------------------
        // Wheel Rotation
        //------------------------------------

        this.updateWheelRotation(dt);

        //------------------------------------
        // Driver Assist
        //------------------------------------

        this.updateDriverAssist();

        //------------------------------------
        // Tire
        //------------------------------------

        this.updateTires();

        //------------------------------------
        // Engine
        //------------------------------------

        this.applyEngineForce();

        //------------------------------------
        // Brake
        //------------------------------------

        this.applyBrakeForce();

        //------------------------------------
        // Steering
        //------------------------------------

        this.applySteeringTorque();
    }


}


