const { createApp, ref, onMounted, nextTick } = Vue;

createApp({
    setup() {
        const currentTab = ref("url");
        const inputUrl = ref("");
        const inputText = ref("");
        const fileName = ref("");
        const selectedFileContent = ref("");
        const parseSources = ref(true);
        const result = ref(null);
        const loading = ref(false);

        const handleFileChange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            fileName.value = file.name;
            const reader = new FileReader();
            reader.onload = (event) => {
                selectedFileContent.value = event.target.result;
            };
            reader.readAsText(file);
        };

        const handleParse = async () => {
            let val = "";
            let isUrl = false;

            if (currentTab.value === "url") {
                val = inputUrl.value.trim();
                isUrl = true;
                if (!val) return alert("Vui lòng nhập URL!");
            } else if (currentTab.value === "text") {
                val = inputText.value.trim();
                if (!val) return alert("Vui lòng dán nội dung M3U8!");
            } else if (currentTab.value === "file") {
                val = selectedFileContent.value;
                if (!val) return alert("Vui lòng chọn file M3U8!");
            }

            loading.value = true;
            try {
                let text = val;
                if (isUrl) {
                    const response = await fetch(val);
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    text = await response.text();
                }

                // Gọi logic từ bộ Parser
                const data = window._CORE_ENGINE_.parse(text, { parseSources: parseSources.value });
                result.value = data;

                // Highlight code after DOM update
                await nextTick();
                if (window.Prism) {
                    Prism.highlightAll();
                }
            } catch (err) {
                result.value = { error: true, message: String(err) };
            } finally {
                loading.value = false;
            }
        };

        const copyJson = () => {
            if (!result.value) return;
            navigator.clipboard
                .writeText(JSON.stringify(result.value, null, 2))
                .then(() => alert("Đã sao chép JSON!"));
        };

        const downloadJson = () => {
            if (!result.value) return;
            const blob = new Blob([JSON.stringify(result.value, null, 2)], {
                type: "application/json",
            });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = "m3u-parsed.json";
            link.click();
        };

        const exportM3U8 = async () => {
            if (!result.value) return;
            loading.value = true;
            try {
                const m3u = await window._CORE_ENGINE_.serialize(result.value);
                const blob = new Blob([m3u], { type: "text/plain" });
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = "exported.m3u8";
                link.click();
            } finally {
                loading.value = false;
            }
        };

        onMounted(() => {
            // Initialize Lucide icons
            if (window.lucide) {
                window.lucide.createIcons();
            }
        });

        return {
            currentTab,
            inputUrl,
            inputText,
            fileName,
            parseSources,
            result,
            loading,
            handleFileChange,
            handleParse,
            copyJson,
            downloadJson,
            exportM3U8,
        };
    },
}).mount("#app");
