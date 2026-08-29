import React, { useCallback, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, Share, Pressable } from 'react-native'
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl'
import { probeDevice, formatDeviceReport, type DeviceReport } from 'react-native-cosmos-gl'

/**
 * Answers "will this run on my phone" before any graph code is written.
 *
 * Worth running first on every device class you intend to support. The engine's
 * requirements — a WebGL2 context and float render targets — are invisible
 * until a shader fails to compile, at which point the error describes a symptom
 * rather than a cause. This reports the cause, in a form you can paste into an
 * issue.
 */
export default function DeviceCheckScreen (): React.ReactElement {
  const [report, setReport] = useState<DeviceReport | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    try {
      setReport(probeDevice(gl as unknown as WebGL2RenderingContext))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    // A frame must still be presented or the surface stays blank and the
    // screen looks hung rather than done.
    gl.endFrameEXP()
  }, [])

  return (
    <View style={styles.root}>
      {/* One pixel, off in a corner: a context is needed to probe, but nothing
          is being drawn with it. */}
      <GLView style={styles.probe} onContextCreate={onContextCreate} />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Device check</Text>

        {error ? (
          <Text style={styles.blocker}>{`Could not create a GL context: ${error}`}</Text>
        ) : !report ? (
          <Text style={styles.pending}>Probing…</Text>
        ) : (
          <>
            <Text style={[styles.verdict, report.supported ? styles.ok : styles.bad]}>
              {report.supported ? 'Supported' : 'Not supported'}
            </Text>

            {report.blockers.map((blocker) => (
              <Text key={blocker} style={styles.blocker}>{blocker}</Text>
            ))}
            {report.warnings.map((warning) => (
              <Text key={warning} style={styles.warning}>{warning}</Text>
            ))}

            <View style={styles.table}>
              <Row label="WebGL2" value={report.isWebGL2 ? 'yes' : 'no'} />
              <Row
                label="Float targets"
                value={report.renderToFloat32 ? 'rgba32f' : report.renderToFloat16 ? 'rgba16f only' : 'none'}
              />
              <Row label="Float blend" value={report.floatBlend ? 'yes' : 'no'} />
              <Row label="Max texture" value={String(report.maxTextureSize)} />
              <Row label="Max point size" value={String(report.maxPointSize)} />
              <Row label="Est. max points" value={report.estimatedMaxPoints.toLocaleString()} />
              <Row label="Renderer" value={report.renderer} />
              <Row label="GLSL" value={report.shadingLanguageVersion} />
            </View>

            <Pressable
              style={styles.button}
              onPress={() => Share.share({ message: formatDeviceReport(report) })}
            >
              <Text style={styles.buttonText}>Share report</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  )
}

function Row ({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1a1a19' },
  probe: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  content: { padding: 24, paddingTop: 64, gap: 12 },
  title: { color: '#f2f5f9', fontSize: 22, fontWeight: '600' },
  pending: { color: '#8b95a5', fontSize: 14 },
  verdict: { fontSize: 17, fontWeight: '700' },
  ok: { color: '#199e70' },
  bad: { color: '#e66767' },
  blocker: { color: '#e66767', fontSize: 13, lineHeight: 19 },
  warning: { color: '#c98500', fontSize: 13, lineHeight: 19 },
  table: { marginTop: 8, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  rowLabel: { color: '#8b95a5', fontSize: 13 },
  rowValue: { color: '#e3e8ef', fontSize: 13, flexShrink: 1, textAlign: 'right' },
  button: {
    marginTop: 16,
    paddingVertical: 11,
    borderRadius: 999,
    alignItems: 'center',
    backgroundColor: 'rgba(57,135,229,0.22)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(57,135,229,0.5)',
  },
  buttonText: { color: '#9ad8fb', fontSize: 14, fontWeight: '600' },
})
