"use strict";
// 서버 종류 템플릿·인코딩 — src/shared/terminal.ts 와 같아야 한다 (test/terminal.test.mjs 가 비교)
const TERMINAL = /* json */ {
  "defaultKeys": {
    "backspace": "del",
    "delete": "vt220",
    "homeEnd": "xterm",
    "enter": "CR"
  },
  "presets": [
    {
      "id": "linux",
      "label": "Linux / BSD",
      "hint": "Ubuntu·Debian·RHEL·Rocky·Alma·SUSE·Alpine·FreeBSD·macOS·Windows OpenSSH — 기본값",
      "termType": "xterm-256color",
      "encoding": "utf-8",
      "keys": {
        "backspace": "del",
        "delete": "vt220",
        "homeEnd": "xterm",
        "enter": "CR"
      }
    },
    {
      "id": "linux-euckr",
      "label": "구형 Linux (EUC-KR)",
      "hint": "RHEL·CentOS 5/6 처럼 LANG=ko_KR.eucKR 로 쓰는 서버",
      "termType": "xterm",
      "encoding": "euc-kr",
      "keys": {
        "backspace": "del",
        "delete": "vt220",
        "homeEnd": "xterm",
        "enter": "CR"
      }
    },
    {
      "id": "embedded",
      "label": "임베디드 (BusyBox)",
      "hint": "OpenWrt·NAS·공유기 등 terminfo 가 없는 BusyBox 셸",
      "termType": "xterm",
      "keys": {
        "backspace": "del",
        "delete": "vt220",
        "homeEnd": "vt220",
        "enter": "CR"
      }
    },
    {
      "id": "aix",
      "label": "AIX",
      "hint": "백스페이스 ^H, xterm (AIX 에는 xterm-256color 가 없는 경우가 많다). 한글 로캘 IBM-eucKR 은 인코딩을 EUC-KR 로",
      "termType": "xterm",
      "keys": {
        "backspace": "ctrl-h",
        "delete": "vt220",
        "homeEnd": "vt220",
        "enter": "CR"
      }
    },
    {
      "id": "hpux",
      "label": "HP-UX",
      "hint": "백스페이스 ^H, Home/End ESC[1~. 한글 로캘 ko_KR.eucKR 은 인코딩을 EUC-KR 로",
      "termType": "xterm",
      "keys": {
        "backspace": "ctrl-h",
        "delete": "vt220",
        "homeEnd": "vt220",
        "enter": "CR"
      }
    },
    {
      "id": "solaris",
      "label": "Solaris",
      "hint": "Solaris 10 이하에는 xterm-256color 가 없어 xterm",
      "termType": "xterm",
      "keys": {
        "backspace": "del",
        "delete": "vt220",
        "homeEnd": "vt220",
        "enter": "CR"
      }
    },
    {
      "id": "sco",
      "label": "SCO / UnixWare",
      "hint": "백스페이스 ^H, ansi 터미널",
      "termType": "ansi",
      "keys": {
        "backspace": "ctrl-h",
        "delete": "vt220",
        "homeEnd": "vt220",
        "enter": "CR"
      }
    },
    {
      "id": "network",
      "label": "네트워크 장비",
      "hint": "Cisco·Juniper·Huawei·HPE 스위치·라우터 — vt100, Delete 는 ^?",
      "termType": "vt100",
      "keys": {
        "backspace": "del",
        "delete": "del",
        "homeEnd": "xterm",
        "enter": "CR"
      }
    }
  ],
  "encodings": [
    {
      "value": "utf-8",
      "label": "UTF-8"
    },
    {
      "value": "euc-kr",
      "label": "EUC-KR (AIX IBM-eucKR · 유닉스 ko_KR)"
    },
    {
      "value": "cp949",
      "label": "CP949 (윈도우 한글 · 구형 장비)"
    },
    {
      "value": "euc-jp",
      "label": "EUC-JP"
    },
    {
      "value": "shift_jis",
      "label": "Shift_JIS"
    },
    {
      "value": "gbk",
      "label": "GBK (중국어 간체)"
    },
    {
      "value": "big5",
      "label": "Big5 (중국어 번체)"
    },
    {
      "value": "latin1",
      "label": "ISO-8859-1 (Latin-1)"
    },
    {
      "value": "cp1252",
      "label": "Windows-1252"
    }
  ]
} /* /json */;
