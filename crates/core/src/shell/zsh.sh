__sc_initial=1
__sc_was_ignore_space=$options[histignorespace]
setopt HIST_IGNORE_SPACE
__sc_prompt() {
    local __sc_status=$?
    if [[ $__sc_initial == 1 ]]; then __sc_initial=0; return "$__sc_status"; fi
    if [[ $__sc_was_ignore_space == off ]]; then unsetopt HIST_IGNORE_SPACE; fi
    unset __sc_was_ignore_space
    printf '\033]633;SC:__SC_MARKER__:%s\007' "$(printf %s "$PWD" | base64 | tr -d '\n')"
    return "$__sc_status"
}
__sc_change() {
    local __sc_data=$BUFFER __sc_path
    [[ $__sc_data == SC__SC_MARKER__:* ]] || return
    __sc_data=${__sc_data#SC__SC_MARKER__:}
    [[ $__sc_data =~ '^[A-Za-z0-9+/]+={0,2}$' ]] || return
    __sc_path=$(printf %s "$__sc_data" | base64 -d) || return
    BUFFER= CURSOR=0
    if builtin cd -- "$__sc_path"; then
        printf '\033]633;SC:__SC_MARKER__:OK\007'
    else
        printf '\033]633;SC:__SC_MARKER__:FAIL\007'
    fi
    __sc_prompt
    zle reset-prompt
}
zle -N __sc_change
bindkey -M emacs '^X^G' __sc_change
bindkey -M viins '^X^G' __sc_change
typeset -ga precmd_functions
precmd_functions=(${precmd_functions:#__sc_prompt} __sc_prompt)
