set -g __sc_initial 1
function __sc_prompt --on-event fish_prompt
    if test "$__sc_initial" = 1
        set -g __sc_initial 0
        return
    end
    printf '\033]633;SC:__SC_MARKER__:%s\007' (printf %s "$PWD" | base64 | tr -d '\n')
end
function __sc_change
    set -l payload (commandline --current-buffer)
    string match -qr '^SC__SC_MARKER__:[A-Za-z0-9+/]+={0,2}$' -- "$payload"; or return
    set -l encoded (string sub -s 36 -- "$payload")
    set -l target (printf %s "$encoded" | base64 -d); or return
    commandline --replace ''
    if builtin cd -- "$target"
        printf '\033]633;SC:__SC_MARKER__:OK\007'
    else
        printf '\033]633;SC:__SC_MARKER__:FAIL\007'
    end
    __sc_prompt
    commandline -f repaint
end
bind \cx\cg __sc_change
bind -M insert \cx\cg __sc_change
