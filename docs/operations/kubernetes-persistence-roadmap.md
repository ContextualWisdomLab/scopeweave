# Kubernetes Persistence & IaC Security Roadmap

## 1. 개요
현재 ScopeWeave Planner는 정적 호스팅(GitHub Pages)에 최적화된 앱으로 배포되고 있으며, Persistence 계층은 사용자 브라우저의 `localStorage` 및 `File System Access API`에 의존하고 있습니다. 그러나 기업용 온프레미스(On-Premise) 또는 Kubernetes 환경에서의 배포가 요구될 경우를 대비해, 본 문서는 K8s 패키징, 스토리지 운영 전략, 그리고 IaC 보안 스캔 방향성을 정리합니다.

## 2. Kubernetes Packaging (Static Nginx)
본 저장소의 `infra/` 및 `Dockerfile`은 앱을 컨테이너로 감싸 Nginx에서 서비스하기 위한 레퍼런스를 제공합니다.
*   **이미지:** Nginx 기반으로 정적 리소스를 제공합니다. (기본 `wbs.json` 포함)
*   **배포:** `Deployment`와 `Service` 매니페스트(`infra/k8s/`)를 통해 클러스터 내에 무상태(Stateless) 형태로 배포됩니다.

## 3. Hosted Persistence Roadmap
앱이 무상태 정적 서버로 서비스될 경우 서버의 `wbs.json`을 직접 수정하는 것은 보안상, 구조상 불가능합니다.
Hosted Persistence를 구현하기 위해서는 다음과 같은 전환이 필요합니다.

*   **Option A: API 백엔드 분리**
    *   상태 관리를 위한 얇은(Thin) CRUD API 서버를 추가로 배포.
    *   WBS 데이터는 DB(PostgreSQL 등) 또는 K8s PV(Persistent Volume)를 통해 영속화.
    *   프론트엔드의 `app.js`에서 파일 API를 통한 직접 I/O 대신 `fetch`를 통한 REST API 호출로 변경.
*   **Option B: Signed Cloud Storage Export**
    *   Presigned URL을 이용해 사용자가 S3나 GCS 버킷에 바로 데이터를 저장하고 불러오는 방식.

## 4. IaC 및 인프라 보안 (Strix companion scans)
현재 Strix 보안 워크플로우(`strix.yml`)는 프론트엔드 및 스크립트 코드 스캔에 집중되어 있습니다. `infra/` 및 컨테이너 스캔을 추가하기 위해 다음과 같은 보안 게이트가 향후 추가되어야 합니다.

*   **IaC Scan:** `checkov`, `tfsec` 또는 Strix Infra mode를 통한 Kubernetes 매니페스트 및 Dockerfile 스캔.
*   **Container Scan:** Trivy를 이용한 생성된 Nginx 컨테이너 이미지 취약점(CVE) 스캔.
*   이러한 인프라 보안 게이트는 코드 스캔과는 별개의 병렬 워크플로우로 분리하여 실행하는 것이 효율적입니다.