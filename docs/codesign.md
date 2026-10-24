# Windows 코드 서명 — 셀프 인증서와 개인 키 관리

[← README](../README.md)

사내·폐쇄망 배포용 Windows 빌드(`npm run dist:win:signed`)는 자체 발급한 코드 서명 인증서로 서명합니다. 이 문서는 그 **개인 키**를 어디에 두고 어떻게 백업·복원하며, 잃어버리거나 유출됐을 때 무엇을 해야 하는지 정리합니다.

> 개인 키를 가진 사람은 무엇이든 "Dany Kim 이 서명한 프로그램"으로 만들 수 있습니다. 이 인증서를 신뢰 루트로 등록한 PC 들은 그 프로그램을 믿습니다. 개인 키(.pfx)와 그 비밀번호는 비밀번호·SSH 개인 키와 같은 수준으로 다룹니다.

## 무엇이 어디에 있나

| 항목 | 위치 | 공개 여부 |
| --- | --- | --- |
| 개인 키 + 인증서 | 빌드 PC의 현재 사용자 인증서 저장소 `Cert:\CurrentUser\My` (`certmgr.msc` → 개인 → 인증서) | **비공개** |
| 개인 키 백업(.pfx) | `-BackupPfx`로 만든 파일. 저장소 밖의 안전한 곳 | **비공개** |
| 공개 인증서(.cer) | `build/codesign/BrightTerm-codesign.cer` (저장소에 커밋됨), 반입 폴더 | 공개해도 됨 |
| 대상 PC 등록 스크립트 | `build/codesign/install-cert.cmd` | 공개해도 됨 |
| 서명 설정 | `electron-builder.win-signed.yml` — 주체 이름 `Dany Kim`으로 저장소에서 찾음 | 비밀 없음 |

- 개인 키는 설정 파일이나 저장소, 환경변수 어디에도 두지 않습니다. electron-builder 는 signtool 로 인증서 저장소에서 키를 꺼내 서명합니다.
- `.gitignore`에 `*.pfx`가 있어 백업 파일이 실수로 커밋되지 않습니다.
- 저장소의 키는 Windows 사용자 계정(DPAPI)으로 보호됩니다. 저장소에서 꺼낼 때 비밀번호를 묻지 않으므로, **그 Windows 계정으로 실행되는 프로그램은 모두 이 키로 서명할 수 있습니다**. 빌드 PC 계정의 보안이 곧 키의 보안입니다.
- Windows 계정 프로필을 잃으면(PC 교체, 재설치, 프로필 손상) 키도 함께 사라집니다. 그래서 백업이 필요합니다.

## 현재 인증서

| 항목 | 값 |
| --- | --- |
| 주체 | `CN=Dany Kim, O=BrightTerm` |
| 지문(SHA-1) | `07848F6B01D73F5D7C2F3DAF3648B38868DE0FC9` |
| 유효기간 | 2026-10-24 ~ 2031-10-24 |
| 키 | RSA 3072, 서명 해시 SHA-256, 내보내기 허용 |
| 만든 방법 | `scripts/codesign-cert.ps1` (기본값) |

확인 명령:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint, NotAfter, HasPrivateKey
```

## 백업

인증서를 만든 직후 한 번, 그리고 PC 를 바꾸기 전에 백업합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\codesign-cert.ps1 -BackupPfx E:\backup\brightterm-codesign.pfx
```

- 비밀번호를 묻습니다. 길고 무작위인 비밀번호를 쓰고, 비밀번호 관리자에 .pfx 와 **따로** 보관합니다.
- .pfx 는 암호화된 USB, 사내 비밀 보관소처럼 접근이 제한된 곳에 둡니다. 클라우드 동기화 폴더, 메일, 메신저, 이 저장소, 반입 폴더에는 두지 않습니다.
- 백업한 뒤 `Get-PfxData -FilePath <pfx> -Password (Read-Host -AsSecureString)`로 파일이 열리는지 확인합니다.

## 다른 PC 에서 서명하기 (복원)

```powershell
Import-PfxCertificate -FilePath E:\backup\brightterm-codesign.pfx -CertStoreLocation Cert:\CurrentUser\My -Password (Read-Host -AsSecureString)
powershell -ExecutionPolicy Bypass -File scripts\codesign-cert.ps1   # 기존 인증서를 찾아 쓰는지 확인 (새로 만들지 않음)
npm run dist:win:signed
```

- `codesign-cert.ps1`은 같은 주체의 유효한 인증서가 있으면 그것을 씁니다. 같은 주체로 두 개 이상 있으면 멈추므로, 하나만 남깁니다.
- 복원한 PC 에서 다시 내보낼 일이 없다면 `Import-PfxCertificate`에 `-Exportable`을 주지 않습니다(기본값). 그러면 키가 내보내기 불가로 들어갑니다.
- 다 쓴 PC 에서는 인증서를 지웁니다: `certmgr.msc` → 개인 → 인증서에서 삭제하거나 `Remove-Item Cert:\CurrentUser\My\<지문>`.

## 잃어버렸을 때

백업 없이 키를 잃은 경우입니다(PC 교체, 프로필 삭제 등).

- 이미 배포한 서명본은 계속 유효합니다. 대상 PC 에 등록된 공개 인증서와 타임스탬프로 확인하므로 개인 키는 필요 없습니다.
- 새 빌드는 같은 인증서로 서명할 수 없습니다. **새 인증서를 만들어야 합니다**:
  1. `scripts\codesign-cert.ps1`로 새 인증서를 만듭니다. `build/codesign/BrightTerm-codesign.cer`가 새 것으로 바뀌니 커밋합니다.
  2. 곧바로 `-BackupPfx`로 백업합니다.
  3. 새 `.cer`를 대상 PC 에 등록합니다(`install-cert.cmd` 또는 GPO). 예전 인증서는 그대로 두어도 됩니다.
  4. 이 문서의 "현재 인증서" 표를 고칩니다.

## 유출됐을 때

.pfx 와 비밀번호가 함께 새어 나갔거나, 빌드 PC 계정이 침해된 경우입니다. 셀프 인증서는 인증 기관이 없어서 **폐기 목록(CRL)으로 무효화할 수 없습니다**. 대상 PC 에서 직접 지워야 합니다.

1. 모든 대상 PC 에서 예전 인증서의 신뢰를 지웁니다. GPO 로 배포했다면 GPO 에서 제거합니다. 직접 등록했다면 관리자 권한으로 다음을 실행합니다(현재 사용자에게만 등록했으면 `-user`를 붙입니다).
   ```cmd
   certutil -delstore Root 07848F6B01D73F5D7C2F3DAF3648B38868DE0FC9
   certutil -delstore TrustedPublisher 07848F6B01D73F5D7C2F3DAF3648B38868DE0FC9
   ```
2. 원하면 예전 인증서를 "신뢰할 수 없는 인증서"(Disallowed) 저장소에 넣어 확실히 막습니다: `certutil -addstore Disallowed BrightTerm-codesign-old.cer`
3. 빌드 PC 저장소와 모든 백업에서 예전 키를 지웁니다.
4. "잃어버렸을 때"의 1~4 단계로 새 인증서를 만들어 배포합니다.
5. 배포한 BrightTerm 을 새 인증서로 다시 서명해 빌드하고, 다시 배포합니다. 예전 서명본은 1번 이후 '신뢰되지 않음'으로 보입니다.

## 만료와 갱신

- 인증서는 **2031-10-24**에 만료됩니다.
- 만료 전에 서명한 파일은 RFC 3161 타임스탬프(DigiCert)가 들어 있어 만료 뒤에도 유효합니다.
- 만료 뒤에는 새 빌드를 서명할 수 없습니다(`codesign-cert.ps1`이 만료된 인증서를 무시합니다). 만료 몇 달 전에 새 인증서를 만들고, 새 `.cer`를 대상 PC 에 미리 배포합니다. 예전 `.cer`는 예전 서명본 확인용으로 남겨 둡니다.
- 서명할 때 타임스탬프 서버(`http://timestamp.digicert.com`)에 접속하므로, 빌드 PC 는 인터넷이 되어야 합니다.

## 참고

- 인증서 만들기·내보내기·백업: `scripts/codesign-cert.ps1`
- 서명 빌드 설정: `electron-builder.win-signed.yml`
- 대상 PC 등록: `build/codesign/install-cert.cmd`
- 변경 내역: [Windows 코드 서명 (셀프 인증서, 사내 배포용)](./CHANGELOG.md#windows-코드-서명-셀프-인증서-사내-배포용)
