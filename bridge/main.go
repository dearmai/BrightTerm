//go:build windows

// BrightTerm 브릿지 — 서버 접근제어(보안) 프로그램이 putty.exe · Xshell.exe · SecureCRT.exe 를 실행하면
// 받은 명령줄을 그대로 BrightTerm.exe 에 넘겨 새 탭으로 접속한다.
//
// 이 프로세스는 그 탭을 닫을 때까지 살아 있다. 클라이언트 프로세스가 끝나는 것으로 접속 종료를 기록하는
// 보안 프로그램과 맞추기 위해서다. 반대로 보안 프로그램이 이 프로세스를 끝내면(접속 시간 만료 등) BrightTerm 이 탭을 닫는다.
// 둘은 named pipe 하나로 이어진다 — BrightTerm 이 붙어 있는 동안 열려 있고, 어느 쪽이든 끝나면 끊긴다.
//
// 인자 형식은 실행 파일 이름으로 정한다(putty / xshell / securecrt). 그 밖의 이름이면 BrightTerm 이 인자를 보고 판단한다.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procCreateNamedPipe  = kernel32.NewProc("CreateNamedPipeW")
	procConnectNamedPipe = kernel32.NewProc("ConnectNamedPipe")
	procMessageBox       = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
)

const (
	pipeAccessDuplex   = 0x3
	pipeRejectRemote   = 0x8
	errorPipeConnected = 535
	mbIconError        = 0x10
	connectTimeout     = 2 * time.Minute
)

func main() {
	self, err := os.Executable()
	if err != nil {
		fail("실행 파일 위치를 알 수 없습니다.")
	}
	app := findApp(filepath.Dir(self))
	if app == "" {
		fail("BrightTerm.exe 를 찾을 수 없습니다.\n브릿지는 BrightTerm 설치 폴더 안의 bridge 폴더에 있어야 합니다.\n(다른 곳에 두려면 BRIGHTTERM_EXE 환경 변수에 BrightTerm.exe 경로를 지정하세요.)")
	}

	pipe := fmt.Sprintf(`\\.\pipe\brightterm-bridge-%d-%d`, os.Getpid(), time.Now().UnixNano())
	h, err := createPipe(pipe)
	if err != nil {
		fail("파이프를 만들지 못했습니다: " + err.Error())
	}

	cmd := exec.Command(app)
	// 원래 명령줄을 다시 나누고 합치지 않고 그대로 붙인다 — 따옴표·공백이 든 비밀번호·경로가 바뀌지 않게
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: fmt.Sprintf(`"%s" --bt-launch=%s --bt-pipe=%s %s`, app, style(self), pipe, rawArgs())}
	if err := cmd.Start(); err != nil {
		fail("BrightTerm 을 실행하지 못했습니다: " + err.Error())
	}
	cmd.Process.Release()

	connected := make(chan bool, 1)
	go func() {
		r, _, e := procConnectNamedPipe.Call(uintptr(h), 0)
		connected <- r != 0 || e == syscall.Errno(errorPipeConnected)
	}()
	select {
	case ok := <-connected:
		if !ok {
			os.Exit(1)
		}
	case <-time.After(connectTimeout):
		os.Exit(1)
	}

	// BrightTerm 이 탭을 닫거나 끝나면 읽기가 실패한다
	buf := make([]byte, 64)
	for {
		var n uint32
		if err := syscall.ReadFile(h, buf, &n, nil); err != nil {
			os.Exit(0)
		}
	}
}

func createPipe(name string) (syscall.Handle, error) {
	p, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	r, _, e := procCreateNamedPipe.Call(uintptr(unsafe.Pointer(p)), pipeAccessDuplex, pipeRejectRemote, 1, 64, 64, 0, 0)
	if syscall.Handle(r) == syscall.InvalidHandle {
		return 0, e
	}
	return syscall.Handle(r), nil
}

// BRIGHTTERM_EXE → 상위 폴더(설치 폴더\bridge\putty.exe) → 같은 폴더
func findApp(dir string) string {
	for _, p := range []string{os.Getenv("BRIGHTTERM_EXE"), filepath.Join(dir, "..", "BrightTerm.exe"), filepath.Join(dir, "BrightTerm.exe")} {
		if p == "" {
			continue
		}
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			abs, _ := filepath.Abs(p)
			return abs
		}
	}
	return ""
}

func style(self string) string {
	name := strings.ToLower(filepath.Base(self))
	for _, s := range []string{"securecrt", "xshell", "putty"} {
		if strings.Contains(name, s) {
			return s
		}
	}
	return "auto"
}

// 명령줄에서 실행 파일 경로(첫 토큰)를 뺀 나머지 — Windows 의 argv[0] 규칙: 따옴표로 시작하면 다음 따옴표까지
func rawArgs() string {
	p := syscall.GetCommandLine()
	n := 0
	for *(*uint16)(unsafe.Add(unsafe.Pointer(p), n*2)) != 0 {
		n++
	}
	cl := syscall.UTF16ToString(unsafe.Slice(p, n))
	i := 0
	if strings.HasPrefix(cl, `"`) {
		if j := strings.Index(cl[1:], `"`); j >= 0 {
			i = j + 2
		} else {
			i = len(cl)
		}
	} else if j := strings.IndexAny(cl, " \t"); j >= 0 {
		i = j
	} else {
		i = len(cl)
	}
	return strings.TrimLeft(cl[i:], " \t")
}

func fail(msg string) {
	t, _ := syscall.UTF16PtrFromString("BrightTerm 브릿지")
	m, _ := syscall.UTF16PtrFromString(msg)
	procMessageBox.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), mbIconError)
	os.Exit(2)
}
