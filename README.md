# ☸ Kubernetes Web Application Deployment Guide

> A complete hands-on guide — from cluster setup to autoscaling a Node.js application in production.

---

## Table of Contents

1. [Cluster Setup](#1-cluster-setup)
2. [Containerize the Application](#2-containerize-the-application)
3. [Deploy to Kubernetes](#3-deploy-to-kubernetes)
4. [ConfigMaps & Secrets](#4-configmaps--secrets)
5. [Expose the Application](#5-expose-the-application)
6. [Persistent Storage](#6-persistent-storage)
7. [Autoscaling (HPA)](#7-autoscaling-hpa)
8. [Monitor & Troubleshoot](#8-monitor--troubleshoot)

---

## 1. Cluster Setup

Start locally with Minikube or use a managed cloud provider.

### Option A — Minikube (local)

```bash
# Install Minikube (macOS / Linux)
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube

# Start a cluster with Docker driver
minikube start --driver=docker --cpus=2 --memory=4096

# Enable the metrics-server add-on (needed for HPA later)
minikube addons enable metrics-server
minikube addons enable ingress

# Verify the cluster is healthy
kubectl cluster-info
kubectl get nodes
```

### Option B — Managed Cloud Cluster

| Provider    | Command |
|-------------|---------|
| Amazon EKS  | `eksctl create cluster --name k8s-lab --region us-east-1` |
| Google GKE  | `gcloud container clusters create k8s-lab --zone us-central1-a` |
| Azure AKS   | `az aks create -g myRG -n k8s-lab --node-count 2` |
| Verify      | `kubectl get nodes -o wide` — all nodes must show **Ready** |

> **Note:** All subsequent steps assume `kubectl` is configured and pointing at your cluster. Run `kubectl config current-context` to confirm.

---

## 2. Containerize the Application

Build a minimal Node.js app, write a Dockerfile, and push the image to a registry.

### app.js — Simple Express Server

```js
const express = require('express');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = '/data/visits.txt';

app.get('/', (req, res) => {
  let visits = 0;
  if (fs.existsSync(DATA_FILE)) {
    visits = parseInt(fs.readFileSync(DATA_FILE, 'utf8')) || 0;
  }
  visits++;
  fs.writeFileSync(DATA_FILE, String(visits));
  res.send(`<h1>Hello from Kubernetes!</h1><p>Visits: ${visits}</p>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
```

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "app.js"]
```

### Build & Push to Docker Hub

```bash
# Replace YOUR_USERNAME with your Docker Hub username
docker build -t YOUR_USERNAME/k8s-app:v1 .
docker login
docker push YOUR_USERNAME/k8s-app:v1

# For Minikube: load image directly (no push needed)
minikube image load YOUR_USERNAME/k8s-app:v1
```

---

## 3. Deploy to Kubernetes

Create a Deployment with 3 replicas and verify the pods are running.

### deployment.yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webapp
  labels:
    app: webapp
spec:
  replicas: 3
  selector:
    matchLabels:
      app: webapp
  template:
    metadata:
      labels:
        app: webapp
    spec:
      containers:
      - name: webapp
        image: YOUR_USERNAME/k8s-app:v1
        ports:
        - containerPort: 3000
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 15
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
```

### Apply & Verify

```bash
kubectl apply -f deployment.yaml
kubectl rollout status deployment/webapp
kubectl get pods -l app=webapp
kubectl describe deployment webapp
```

> **Important:** Setting `resources.requests` is required for HPA to work in step 7. Never skip it.

---

## 4. ConfigMaps & Secrets

Separate configuration from code using ConfigMaps for plain settings and Secrets for sensitive credentials.

### configmap.yaml

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: webapp-config
data:
  PORT: "3000"
  APP_ENV: "production"
  LOG_LEVEL: "info"
```

### secret.yaml — Values must be base64-encoded

```yaml
# Encode values: echo -n 'mypassword' | base64
apiVersion: v1
kind: Secret
metadata:
  name: webapp-secret
type: Opaque
data:
  DB_PASSWORD: bXlwYXNzd29yZA==
  API_KEY: c3VwZXJzZWNyZXRrZXk=
```

### Attach to Deployment — add inside `containers` section

```yaml
        envFrom:
        - configMapRef:
            name: webapp-config
        - secretRef:
            name: webapp-secret
```

### Apply

```bash
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml
kubectl apply -f deployment.yaml   # re-apply with envFrom added
kubectl exec -it $(kubectl get pod -l app=webapp -o name | head -1) -- env | grep PORT
```

> **Warning:** Never commit `secret.yaml` to version control. Use a tool like Sealed Secrets or Vault in production.

---

## 5. Expose the Application

Create a ClusterIP Service, then route external traffic through an Ingress resource.

### service.yaml

```yaml
apiVersion: v1
kind: Service
metadata:
  name: webapp-svc
spec:
  selector:
    app: webapp
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: ClusterIP
```

### ingress.yaml

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webapp-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: webapp.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: webapp-svc
            port:
              number: 80
```

### Test Access

```bash
kubectl apply -f service.yaml
kubectl apply -f ingress.yaml

# Minikube: get the cluster IP and add to /etc/hosts
echo "$(minikube ip) webapp.local" | sudo tee -a /etc/hosts
curl http://webapp.local

# Or use port-forward for quick testing
kubectl port-forward svc/webapp-svc 8080:80
curl http://localhost:8080
```

---

## 6. Persistent Storage

Create a PersistentVolume and PVC so visit data survives pod restarts.

### pv-pvc.yaml

```yaml
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: webapp-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
  - ReadWriteOnce
  hostPath:
    path: "/mnt/data/webapp"
  persistentVolumeReclaimPolicy: Retain
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: webapp-pvc
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 500Mi
```

### Mount PVC in Deployment — add inside `containers` and `volumes`

```yaml
        # Inside containers:
        volumeMounts:
        - name: data-volume
          mountPath: /data

      # At spec level (same indentation as containers):
      volumes:
      - name: data-volume
        persistentVolumeClaim:
          claimName: webapp-pvc
```

### Verify Storage is Bound

```bash
kubectl apply -f pv-pvc.yaml
kubectl apply -f deployment.yaml
kubectl get pv,pvc
# Both should show STATUS = Bound
kubectl exec -it $(kubectl get pod -l app=webapp -o name | head -1) -- ls /data
```

> **Note:** Use a `StorageClass` with dynamic provisioning (e.g., `gp2` on EKS) in production instead of `hostPath`.

---

## 7. Autoscaling (HPA)

Scale pods automatically between 2–10 replicas based on CPU utilization.

### hpa.yaml

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: webapp-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: webapp
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
```

### Apply & Generate Load to Trigger Scaling

```bash
kubectl apply -f hpa.yaml
kubectl get hpa webapp-hpa --watch

# Simulate traffic with a load-generator pod
kubectl run load-gen --image=busybox --restart=Never -- \
  /bin/sh -c "while true; do wget -q -O- http://webapp-svc; done"

# Watch pods scale up in a second terminal
kubectl get pods -l app=webapp --watch

# Stop load generator
kubectl delete pod load-gen
```

> **Note:** HPA checks metrics every 15 seconds by default. Scale-down has a 5-minute stabilization window to prevent flapping.

---

## 8. Monitor & Troubleshoot

Essential commands for inspecting logs, resource usage, and diagnosing failures.

### Logs

```bash
# Logs from all webapp pods (live stream)
kubectl logs -l app=webapp -f --all-containers

# Previous container logs (useful after a crash)
kubectl logs <pod-name> --previous

# Filter logs since last 30 minutes
kubectl logs -l app=webapp --since=30m
```

### Resource Usage

```bash
# Pod-level CPU & memory
kubectl top pods -l app=webapp

# Node-level resource usage
kubectl top nodes

# HPA current vs target metrics
kubectl describe hpa webapp-hpa
```

### Describe & Events

```bash
# Inspect a specific pod (events, image, probes)
kubectl describe pod <pod-name>

# Cluster-wide recent events sorted by time
kubectl get events --sort-by=.metadata.creationTimestamp

# Open a shell inside a running pod
kubectl exec -it <pod-name> -- /bin/sh

# Deployment rollout history
kubectl rollout history deployment/webapp

# Roll back to previous version
kubectl rollout undo deployment/webapp
```

### Common Issues Checklist

- **Pod stuck in `Pending`** → Run `kubectl describe pod` and check for insufficient CPU/memory or missing PVC.
- **Pod in `CrashLoopBackOff`** → Check `kubectl logs --previous` for the crash reason.
- **HPA stuck at `<unknown>`** → metrics-server not running. Enable with `minikube addons enable metrics-server`.
- **Ingress 404** → Verify the `ingressClassName` matches the controller and the host header in your request.
- **Secret not injected** → Confirm `secretRef.name` matches the Secret metadata name exactly.
